package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"phonepad/daemon/internal/input"
)

const maxBatchFiles = 20

var batchIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type batchFile struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Bytes  *int64 `json:"bytes,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}
type batchManifest struct {
	Version int         `json:"version"`
	ID      string      `json:"id"`
	Files   []batchFile `json:"files"`
}
type batchItemReceipt struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type batchReceipt struct {
	Version      int                `json:"version"`
	ID           string             `json:"id"`
	ManifestHash string             `json:"manifestHash"`
	Files        []batchItemReceipt `json:"files"`
	Folder       string             `json:"folder"`
	Clipboard    string             `json:"clipboard"`
	Replayed     bool               `json:"replayed,omitempty"`
}

func (s *Server) batchRoot() (string, error) {
	if s.uploadDir != "" {
		return s.uploadDir, nil
	}
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Downloads", "Phonepad"), err
}
func batchFilename(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 180 && !strings.ContainsAny(name, "/\\") && strings.IndexFunc(name, unicode.IsControl) < 0
}
func readBatchReceipt(folder string) (batchReceipt, error) {
	var receipt batchReceipt
	data, err := os.ReadFile(filepath.Join(folder, ".receipt.json"))
	if err != nil {
		return receipt, err
	}
	err = json.Unmarshal(data, &receipt)
	return receipt, err
}

// A whole batch becomes visible by one same-filesystem directory rename. No
// clipboard publication or key injection can occur while receiving a part.
func (s *Server) handleFileBatches(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	if r.Method != "POST" && r.Method != "GET" {
		http.Error(w, "method", 405)
		return
	}
	var filesPermit mutationPermit
	if r.Method == "POST" {
		var permitted bool
		filesPermit, permitted = s.captureMutationPermit(mutationScopeFiles)
		if !permitted {
			http.Error(w, "file permission revoked", http.StatusForbidden)
			return
		}
	}
	root, err := s.batchRoot()
	if err != nil {
		http.Error(w, "storage unavailable", 503)
		return
	}
	respond := func(receipt batchReceipt, status int) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(receipt)
	}
	if r.Method == "GET" {
		id := r.URL.Query().Get("id")
		if !batchIDPattern.MatchString(id) {
			http.Error(w, "invalid batch", 400)
			return
		}
		receipt, err := readBatchReceipt(filepath.Join(root, "batch-"+id))
		if err != nil {
			http.Error(w, "unknown batch; do not assume failure", 404)
			return
		}
		receipt.Replayed = true
		respond(receipt, 200)
		return
	}
	if !s.uploadMu.TryLock() {
		http.Error(w, "transfer busy", 429)
		return
	}
	defer s.uploadMu.Unlock()
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "multipart required", 415)
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "manifest" {
		http.Error(w, "manifest required first", 400)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(part, 32769))
	if err != nil || len(raw) > 32768 {
		http.Error(w, "invalid manifest", 400)
		return
	}
	var manifest batchManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Version != 1 || !batchIDPattern.MatchString(manifest.ID) || len(manifest.Files) < 1 || len(manifest.Files) > maxBatchFiles {
		http.Error(w, "invalid manifest", 400)
		return
	}
	for _, file := range manifest.Files {
		if !batchFilename(file.Name) || len(file.Type) > 128 || (file.Bytes != nil && (*file.Bytes < 0 || *file.Bytes > maxUpload)) {
			http.Error(w, "invalid file metadata", 400)
			return
		}
		if file.SHA256 != "" {
			sum, e := hex.DecodeString(file.SHA256)
			if e != nil || len(sum) != 32 || hex.EncodeToString(sum) != file.SHA256 {
				http.Error(w, "invalid checksum", 400)
				return
			}
		}
	}
	canonical, _ := json.Marshal(manifest)
	digest := sha256.Sum256(canonical)
	manifestHash := hex.EncodeToString(digest[:])
	destination := filepath.Join(root, "batch-"+manifest.ID)
	if old, readErr := readBatchReceipt(destination); readErr == nil {
		if old.ManifestHash != manifestHash {
			http.Error(w, "batch identity conflict", 409)
			return
		}
		old.Replayed = true
		respond(old, 200)
		return
	}
	if _, err = os.Stat(destination); err == nil {
		http.Error(w, "batch result uncertain; do not replay", 409)
		return
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		http.Error(w, "storage unavailable", 507)
		return
	}
	staging, err := os.MkdirTemp(root, ".batch-receiving-")
	if err != nil {
		http.Error(w, "storage unavailable", 507)
		return
	}
	defer os.RemoveAll(staging)
	receipt := batchReceipt{Version: 1, ID: manifest.ID, ManifestHash: manifestHash, Folder: "Downloads/Phonepad/batch-" + manifest.ID, Clipboard: "unavailable"}
	var total int64
	paths := make([]string, 0, len(manifest.Files))
	for index, meta := range manifest.Files {
		part, err = reader.NextPart()
		if err != nil || part.FormName() != "file-"+strconv.Itoa(index) {
			http.Error(w, "missing or unordered file", 400)
			return
		}
		// Prefix keeps duplicate names distinct and mirrors picker ordering.
		name := strconv.Itoa(index+1) + "-" + meta.Name
		file, createErr := os.OpenFile(filepath.Join(staging, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if createErr != nil {
			http.Error(w, "storage unavailable", 507)
			return
		}
		hash := sha256.New()
		size, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(part, maxUpload-total+1))
		syncErr := file.Sync()
		closeErr := file.Close()
		total += size
		if total > maxUpload {
			http.Error(w, "batch exceeds 100 MiB", 413)
			return
		}
		if copyErr != nil {
			http.Error(w, "incomplete file", 400)
			return
		}
		if syncErr != nil || closeErr != nil {
			http.Error(w, "storage unavailable", 507)
			return
		}
		sum := hex.EncodeToString(hash.Sum(nil))
		if (meta.Bytes != nil && size != *meta.Bytes) || (meta.SHA256 != "" && meta.SHA256 != sum) {
			http.Error(w, "file integrity mismatch", 409)
			return
		}
		receipt.Files = append(receipt.Files, batchItemReceipt{Name: name, Bytes: size, SHA256: sum})
		paths = append(paths, filepath.Join(destination, name))
	}
	if _, err = reader.NextPart(); err != io.EOF {
		http.Error(w, "unexpected or incomplete multipart", 400)
		return
	}
	if r.Context().Err() != nil {
		http.Error(w, "cancelled before publication", 408)
		return
	}
	// Persist a conservative receipt before publication, so a process crash never
	// causes the same batch ID to be published again. Clipboard success is later.
	publish := func() error {
		data, _ := json.Marshal(receipt)
		if err := os.WriteFile(filepath.Join(staging, ".receipt.json"), data, 0600); err != nil {
			return err
		}
		return os.Rename(staging, destination)
	}
	if err = s.runPermittedMutation(filesPermit, publish); err != nil {
		if errors.Is(err, errMutationPermission) {
			http.Error(w, "file permission revoked; batch was not published", http.StatusForbidden)
			return
		}
		http.Error(w, "cannot publish batch", 507)
		return
	}

	persistReceipt := func() error {
		data, _ := json.Marshal(receipt)
		temporary := filepath.Join(destination, ".receipt-next.json")
		if err := os.WriteFile(temporary, data, 0600); err != nil {
			return err
		}
		if err := os.Rename(temporary, filepath.Join(destination, ".receipt.json")); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		return nil
	}
	clipboardPermit, clipboardPermitted := s.captureMutationPermit(mutationScopeClipboard)
	if clipboardPermitted {
		copyErr := s.runPermittedMutation(clipboardPermit, func() error {
			s.clipboardMu.Lock()
			defer s.clipboardMu.Unlock()
			if s.clipboard == nil {
				s.clipboard = systemClipboard()
			}
			input.ClipboardMu.Lock()
			defer input.ClipboardMu.Unlock()
			writer, ok := s.clipboard.(interface{ CopyFiles([]string) error })
			if len(paths) == 1 {
				kind, media := clipboardKindFor(manifest.Files[0].Type)
				if manifest.Files[0].Type == "" || manifest.Files[0].Type == "application/octet-stream" {
					kind, media = clipboardKindFor(clipboardMediaTypeForName(manifest.Files[0].Name))
				}
				if s.clipboard.Copy(paths[0], kind, media) == nil {
					receipt.Clipboard = "ready"
				}
			} else if ok && writer.CopyFiles(paths) == nil {
				receipt.Clipboard = "ready"
			}
			if receipt.Clipboard == "ready" {
				if err := persistReceipt(); err != nil {
					receipt.Clipboard = "unavailable"
					return err
				}
			}
			return nil
		})
		if copyErr != nil && !errors.Is(copyErr, errMutationPermission) {
			// The batch is already published; keep its explicit unavailable
			// clipboard result instead of turning a copy failure into a fake ready.
			receipt.Clipboard = "unavailable"
		}
	}
	// Never inject Ctrl+V or Enter. The user chooses when/where to paste.
	if receipt.Clipboard != "ready" {
		receipt.Clipboard = "unavailable"
	}
	respond(receipt, 201)
}
