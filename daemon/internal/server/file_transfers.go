package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"phonepad/daemon/internal/filebatches"
	"phonepad/daemon/internal/input"
)

type transferClipboard struct {
	State    string `json:"state"`
	Replayed bool   `json:"replayed,omitempty"`
}
type transferReceipt struct {
	filebatches.Status
	Clipboard *transferClipboard `json:"clipboard,omitempty"`
}

func (s *Server) transferStore() (*filebatches.Store, error) {
	s.fileTransfersOnce.Do(func() {
		root, err := s.batchRoot()
		s.fileTransfersErr = err
		if err == nil {
			s.fileTransfers = filebatches.New(root)
		}
	})
	return s.fileTransfers, s.fileTransfersErr
}

func writeTransferJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) handleFileTransfers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" {
		http.Error(w, "method", 405)
		return
	}
	id, action := r.URL.Query().Get("id"), r.URL.Query().Get("action")
	if r.Method == "GET" && id == "" {
		writeTransferJSON(w, map[string]any{"version": filebatches.SchemaVersion, "maxFiles": filebatches.MaxFiles, "maxBytes": filebatches.MaxTotalBytes, "maxChunkBytes": filebatches.MaxChunkBytes, "ttlSeconds": int(filebatches.TTL.Seconds())})
		return
	}
	if action != "begin" && !batchIDPattern.MatchString(id) {
		http.Error(w, "invalid batch", 400)
		return
	}
	store, err := s.transferStore()
	if err != nil {
		http.Error(w, "storage unavailable", 507)
		return
	}
	// Bound each request, including on servers without a global read timeout.
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(25 * time.Second))
	var status filebatches.Status
	var clipboard *transferClipboard
	switch {
	case r.Method == "GET":
		status, err = store.Status(id)
	case r.Method == "PUT" && action == "":
		if !s.uploadMu.TryLock() {
			http.Error(w, "transfer busy", 429)
			return
		}
		defer s.uploadMu.Unlock()
		index, e1 := strconv.Atoi(r.URL.Query().Get("index"))
		offset, e2 := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		if e1 != nil || e2 != nil {
			http.Error(w, "invalid chunk coordinates", 400)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, filebatches.MaxChunkBytes)
		data, e := io.ReadAll(r.Body)
		if e != nil {
			http.Error(w, "invalid chunk body", 413)
			return
		}
		if r.Context().Err() != nil {
			http.Error(w, "cancelled", 408)
			return
		}
		status, err = store.WriteChunk(id, index, offset, data, r.Header.Get("X-Chunk-SHA256"))
	case r.Method == "POST" && action == "begin":
		media, _, parseErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if parseErr != nil || media != "application/json" {
			http.Error(w, "json required", 415)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 32768)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var manifest filebatches.Manifest
		if decoder.Decode(&manifest) != nil || decoder.Decode(new(any)) != io.EOF {
			http.Error(w, "invalid manifest", 400)
			return
		}
		status, err = store.Begin(manifest)
	case r.Method == "POST" && action == "commit":
		if r.Context().Err() != nil {
			http.Error(w, "cancelled", 408)
			return
		}
		status, _, err = store.Commit(id)
	case r.Method == "POST" && action == "cancel":
		status, err = store.Cancel(id)
	case r.Method == "POST" && action == "clipboard":
		// Serialize with legacy uploads too; only a stored, verified batch can
		// acquire clipboard ownership. A retry reads the durable claim.
		if !s.uploadMu.TryLock() {
			http.Error(w, "clipboard busy", 429)
			return
		}
		defer s.uploadMu.Unlock()
		status, err = store.Status(id)
		if err == nil && status.State != "stored" {
			http.Error(w, "batch incomplete", 409)
			return
		}
		if err == nil {
			if r.Context().Err() != nil {
				http.Error(w, "cancelled", 408)
				return
			}
			clipboard, err = s.copyTransfer(status)
		}
	default:
		http.Error(w, "invalid action", 400)
		return
	}
	if err != nil {
		transferError(w, err)
		return
	}
	if status.State == "stored" && clipboard == nil {
		root, _ := s.batchRoot()
		value := readTransferClipboard(filepath.Join(root, "batch-"+status.ID))
		clipboard = &value
	}
	writeTransferJSON(w, transferReceipt{Status: status, Clipboard: clipboard})
}

func transferError(w http.ResponseWriter, err error) {
	code := 507
	// Storage errors are intentionally not reflected to clients: paths and
	// local file contents do not belong in protocol errors.
	switch {
	case errors.Is(err, filebatches.ErrInvalid):
		code = 400
	case errors.Is(err, filebatches.ErrConflict), errors.Is(err, filebatches.ErrCorrupt):
		code = 409
	case errors.Is(err, filebatches.ErrNotFound):
		code = 404
	case errors.Is(err, filebatches.ErrCapacity):
		code = 429
	case errors.Is(err, filebatches.ErrExpired):
		code = 410
	}
	http.Error(w, http.StatusText(code), code)
}

const transferClipboardFile = ".phonepad-clipboard.json"

func readTransferClipboard(folder string) transferClipboard {
	path := filepath.Join(folder, transferClipboardFile)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return transferClipboard{State: "unrequested"}
	}
	uncertain := transferClipboard{State: "uncertain", Replayed: true}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024 {
		return uncertain
	}
	data, err := os.ReadFile(path)
	var receipt transferClipboard
	if err != nil || json.Unmarshal(data, &receipt) != nil {
		return uncertain
	}
	if receipt.State != "ready" && receipt.State != "unavailable" && receipt.State != "uncertain" {
		return uncertain
	}
	receipt.Replayed = true
	return receipt
}

func syncTransferDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *Server) copyTransfer(status filebatches.Status) (*transferClipboard, error) {
	root, err := s.batchRoot()
	if err != nil {
		return nil, err
	}
	folder := filepath.Join(root, "batch-"+status.ID)
	marker := filepath.Join(folder, transferClipboardFile)
	claim, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		receipt := readTransferClipboard(folder)
		return &receipt, nil
	}
	if err != nil {
		return nil, err
	}
	_, err = claim.WriteString(`{"state":"uncertain"}`)
	if err == nil {
		err = claim.Sync()
	}
	closeErr := claim.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = syncTransferDirectory(folder)
	}
	if err != nil {
		return nil, err
	} // Never touch clipboard before durable claim.
	paths := make([]string, len(status.Files))
	for i, f := range status.Files {
		paths[i] = filepath.Join(folder, f.Name)
		info, err := os.Lstat(paths[i])
		if err != nil || !info.Mode().IsRegular() || info.Size() != f.Bytes {
			return &transferClipboard{State: "uncertain"}, nil
		}
		file, err := os.Open(paths[i])
		if err != nil {
			return &transferClipboard{State: "uncertain"}, nil
		}
		hash := sha256.New()
		count, readErr := io.Copy(hash, io.LimitReader(file, f.Bytes+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || count != f.Bytes || hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
			return &transferClipboard{State: "uncertain"}, nil
		}
	}
	receipt := transferClipboard{State: "unavailable"}
	s.clipboardMu.Lock()
	if s.clipboard == nil {
		s.clipboard = systemClipboard()
	}
	input.ClipboardMu.Lock()
	if len(paths) == 1 {
		media := status.Files[0].Type
		if media == "" || media == "application/octet-stream" {
			media = clipboardMediaTypeForName(status.Files[0].Name)
		}
		kind, media := clipboardKindFor(media)
		if s.clipboard.Copy(paths[0], kind, media) == nil {
			receipt.State = "ready"
		}
	} else if writer, ok := s.clipboard.(interface{ CopyFiles([]string) error }); ok {
		if writer.CopyFiles(paths) == nil {
			receipt.State = "ready"
		}
	}
	input.ClipboardMu.Unlock()
	s.clipboardMu.Unlock()
	// The claim survives a crash after Copy. No replay can invoke Copy twice.
	data, _ := json.Marshal(receipt)
	f, err := os.CreateTemp(folder, ".clipboard-receipt-")
	if err != nil {
		return &transferClipboard{State: "uncertain"}, nil
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr = f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), marker)
	}
	if err == nil {
		err = syncTransferDirectory(folder)
	}
	if err != nil {
		return &transferClipboard{State: "uncertain"}, nil
	}
	return &receipt, nil
}
