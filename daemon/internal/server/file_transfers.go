package server

import (
	"bytes"
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
	var filesPermit mutationPermit
	var clipboardPermit mutationPermit
	switch {
	case r.Method == "PUT" && action == "":
		var permitted bool
		filesPermit, permitted = s.captureMutationPermit(mutationScopeFiles)
		if !permitted {
			http.Error(w, "file permission revoked", http.StatusForbidden)
			return
		}
	case r.Method == "POST" && (action == "begin" || action == "commit"):
		var permitted bool
		filesPermit, permitted = s.captureMutationPermit(mutationScopeFiles)
		if !permitted {
			http.Error(w, "file permission revoked", http.StatusForbidden)
			return
		}
	case r.Method == "POST" && action == "clipboard":
		var permitted bool
		clipboardPermit, permitted = s.captureMutationPermit(mutationScopeClipboard)
		if !permitted {
			http.Error(w, "clipboard permission revoked", http.StatusForbidden)
			return
		}
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
		status, err = store.WriteChunkWithGuard(id, index, offset, data, r.Header.Get("X-Chunk-SHA256"), func(effect func() error) error {
			return s.runPermittedMutation(filesPermit, effect)
		})
	case r.Method == "POST" && action == "begin":
		manifest, _, parseErr := decodeTransferManifest(w, r, false)
		if parseErr != nil {
			http.Error(w, "invalid manifest", 400)
			return
		}
		status, err = store.BeginWithGuard(manifest, func(effect func() error) error {
			return s.runPermittedMutation(filesPermit, effect)
		})
	case r.Method == "POST" && action == "commit":
		if r.Context().Err() != nil {
			http.Error(w, "cancelled", 408)
			return
		}
		status, _, err = store.CommitWithGuard(id, func(effect func() error) error {
			return s.runPermittedMutation(filesPermit, effect)
		})
	case r.Method == "POST" && action == "cancel":
		manifest, present, parseErr := decodeTransferManifest(w, r, true)
		if parseErr != nil {
			http.Error(w, "invalid manifest", 400)
			return
		}
		if present && manifest.ID != id {
			http.Error(w, "manifest ID does not match batch", 400)
			return
		}
		if present {
			status, err = store.Begin(manifest)
		}
		// A published batch is immutable. Return its receipt so a client can
		// discard its local copy without turning a successful no-op into an
		// error or deleting the published directory.
		if err == nil && status.State == filebatches.Stored {
			break
		}
		if err == nil {
			status, err = store.Cancel(id)
		}
		if errors.Is(err, filebatches.ErrConflict) && status.State == filebatches.Stored {
			err = nil
		}
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
			clipboard, err = s.copyTransfer(status, clipboardPermit)
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
	case errors.Is(err, errMutationPermission):
		code = http.StatusForbidden
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

func decodeTransferManifest(w http.ResponseWriter, r *http.Request, optional bool) (filebatches.Manifest, bool, error) {
	var manifest filebatches.Manifest
	if optional && (r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0) {
		return manifest, false, nil
	}
	media, _, parseErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if parseErr != nil || media != "application/json" {
		return manifest, false, errors.New("json required")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	raw, readErr := io.ReadAll(r.Body)
	if readErr != nil {
		return manifest, false, readErr
	}
	if optional && len(bytes.TrimSpace(raw)) == 0 {
		return manifest, false, nil
	}
	if len(raw) == 0 {
		return manifest, false, errors.New("manifest required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, false, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return manifest, false, errors.New("trailing JSON data")
	}
	return manifest, true, nil
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

func (s *Server) copyTransfer(status filebatches.Status, permit mutationPermit) (*transferClipboard, error) {
	root, err := s.batchRoot()
	if err != nil {
		return nil, err
	}
	folder := filepath.Join(root, "batch-"+status.ID)
	marker := filepath.Join(folder, transferClipboardFile)
	if info, statErr := os.Lstat(marker); statErr == nil {
		if info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			receipt := readTransferClipboard(folder)
			return &receipt, nil
		}
		return &transferClipboard{State: "uncertain", Replayed: true}, nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, statErr
	}
	// Verify every published file before creating the durable clipboard claim.
	// Hashing can read up to 100 MiB and must not hold mutationGate.
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
	var receipt transferClipboard
	var haveReceipt bool
	err = s.runPermittedMutation(permit, func() error {
		claim, claimErr := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(claimErr) {
			receipt = readTransferClipboard(folder)
			receipt.Replayed = true
			haveReceipt = true
			return nil
		}
		if claimErr != nil {
			return claimErr
		}
		claimErr = func() error {
			_, writeErr := claim.WriteString(`{"state":"uncertain"}`)
			if writeErr == nil {
				writeErr = claim.Sync()
			}
			closeErr := claim.Close()
			if writeErr == nil {
				writeErr = closeErr
			}
			if writeErr == nil {
				writeErr = syncTransferDirectory(folder)
			}
			return writeErr
		}()
		if claimErr != nil {
			return claimErr
		} // Never touch clipboard before the durable claim.

		receipt = transferClipboard{State: "unavailable"}
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
		temporary, tempErr := os.CreateTemp(folder, ".clipboard-receipt-")
		if tempErr != nil {
			receipt = transferClipboard{State: "uncertain"}
			haveReceipt = true
			return nil
		}
		defer os.Remove(temporary.Name())
		_, tempErr = temporary.Write(data)
		if tempErr == nil {
			tempErr = temporary.Sync()
		}
		closeErr := temporary.Close()
		if tempErr == nil {
			tempErr = closeErr
		}
		if tempErr == nil {
			tempErr = os.Rename(temporary.Name(), marker)
		}
		if tempErr == nil {
			tempErr = syncTransferDirectory(folder)
		}
		if tempErr != nil {
			receipt = transferClipboard{State: "uncertain"}
		}
		haveReceipt = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !haveReceipt {
		return &transferClipboard{State: "uncertain"}, nil
	}
	return &receipt, nil
}
