package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"phonepad/daemon/internal/input"
	"phonepad/daemon/internal/privatefs"
)

const maxUpload = 100 << 20

const maxIntentBytes = 32

// Stream one explicitly selected file to disk; never load attachments into RAM
// or execute/open them. Files are private and are not served by the web server.
func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	filesPermit, permitted := s.captureMutationPermit(mutationScopeFiles)
	if !permitted {
		http.Error(w, "file permission revoked", http.StatusForbidden)
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
	var (
		intent              string
		haveIntent          bool
		file                *os.File
		name                string
		mediaType           string
		size                int64
		dir                 string
		fileSeen            bool
		clipboardPermit     mutationPermit
		haveClipboardPermit bool
	)
	if s.uploadDir != "" {
		dir = s.uploadDir
	} else {
		home, e := os.UserHomeDir()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		dir = filepath.Join(home, "Downloads", "Phonepad")
	}
	var receivingPath string
	defer func() {
		if receivingPath != "" {
			_ = os.Remove(receivingPath)
		}
		if file != nil {
			_ = file.Close()
		}
	}()

	for {
		part, nextErr := reader.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			http.Error(w, "invalid multipart transfer", 400)
			return
		}
		switch part.FormName() {
		case "intent":
			if haveIntent {
				http.Error(w, "duplicate intent", 400)
				return
			}
			value, readErr := io.ReadAll(io.LimitReader(part, maxIntentBytes+1))
			if readErr != nil || len(value) > maxIntentBytes {
				http.Error(w, "invalid intent", 400)
				return
			}
			intent = string(value)
			if intent != "" && intent != "clipboard" {
				http.Error(w, "unsupported intent", 400)
				return
			}
			if intent == "clipboard" {
				clipboardPermit, haveClipboardPermit = s.captureMutationPermit(mutationScopeClipboard)
				if !haveClipboardPermit {
					http.Error(w, "clipboard permission revoked", http.StatusForbidden)
					return
				}
			}
			haveIntent = true
		case "file":
			if fileSeen {
				http.Error(w, "one file per transfer", 400)
				return
			}
			fileSeen = true
			name = filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
			name = strings.Map(func(r rune) rune {
				if unicode.IsControl(r) {
					return -1
				}
				return r
			}, name)
			if name == "" || name == "." || name == ".." || len(name) > 180 {
				http.Error(w, "invalid filename", 400)
				return
			}
			if err = os.MkdirAll(dir, 0700); err != nil {
				http.Error(w, "storage unavailable", 507)
				return
			}
			if err = privatefs.Secure(dir, true); err != nil {
				http.Error(w, "storage unavailable", 507)
				return
			}
			file, err = os.CreateTemp(dir, ".receiving-*")
			if err != nil {
				http.Error(w, "storage unavailable", 507)
				return
			}
			receivingPath = file.Name()
			if err = privatefs.Secure(receivingPath, false); err != nil {
				http.Error(w, "storage unavailable", 507)
				return
			}
			mediaType = clipboardMediaType(part.Header.Get("Content-Type"))
			size, err = io.Copy(file, io.LimitReader(part, maxUpload+1))
			if size > maxUpload {
				http.Error(w, "file exceeds 100 MiB", 413)
				return
			}
			if err != nil {
				http.Error(w, "incomplete transfer", 400)
				return
			}
		default:
			http.Error(w, "unexpected multipart field", 400)
			return
		}
	}
	if !fileSeen || file == nil {
		http.Error(w, "file required", 400)
		return
	}
	if err = file.Sync(); err != nil {
		http.Error(w, "storage full", 507)
		return
	}
	if err = file.Close(); err != nil {
		http.Error(w, "storage unavailable", 507)
		return
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	saved := stem + "-" + strings.TrimPrefix(filepath.Base(file.Name()), ".receiving-") + ext
	// A hard link publishes atomically and fails if a destination already exists.
	if err = s.runPermittedMutation(filesPermit, func() error {
		return os.Link(receivingPath, filepath.Join(dir, saved))
	}); err != nil {
		if errors.Is(err, errMutationPermission) {
			http.Error(w, "file permission revoked; file was not published", http.StatusForbidden)
			return
		}
		http.Error(w, "cannot save file", 507)
		return
	}
	response := map[string]any{"name": saved, "bytes": size, "folder": "Downloads/Phonepad"}
	if intent == "clipboard" {
		kind, clipboardType := clipboardKindFor(mediaType)
		// A few document pickers omit Content-Type for photo assets. Use the
		// sanitized filename as a narrow fallback so HEIC/JPEG/PNG selections
		// still become image clipboard data without treating arbitrary files as
		// images.
		if mediaType == "" || mediaType == "application/octet-stream" {
			if fileType := clipboardMediaTypeForName(name); fileType != "" {
				kind, clipboardType = clipboardKindFor(fileType)
			}
		}
		copyErr := errors.New("clipboard permission revoked")
		if haveClipboardPermit {
			runErr := s.runPermittedMutation(clipboardPermit, func() error {
				s.clipboardMu.Lock()
				defer s.clipboardMu.Unlock()
				writer := s.clipboard
				if writer == nil {
					writer = systemClipboard()
					s.clipboard = writer
				}
				input.ClipboardMu.Lock()
				copyErr = writer.Copy(filepath.Join(dir, saved), kind, clipboardType)
				input.ClipboardMu.Unlock()
				return nil
			})
			if runErr != nil && !errors.Is(runErr, errMutationPermission) {
				copyErr = runErr
			}
		}
		response["clipboardKind"] = string(kind)
		if copyErr == nil {
			response["clipboard"] = "ready"
		} else {
			response["clipboard"] = "unavailable"
			response["detail"] = "El archivo se guardó, pero no se pudo preparar el portapapeles."
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(201)
	_ = json.NewEncoder(w).Encode(response)
}

func clipboardMediaTypeForName(name string) string {
	if ext := strings.ToLower(filepath.Ext(name)); ext != "" {
		switch ext {
		case ".avif":
			return "image/avif"
		case ".bmp":
			return "image/bmp"
		case ".gif":
			return "image/gif"
		case ".heic":
			return "image/heic"
		case ".heif":
			return "image/heif"
		case ".jxl":
			return "image/jxl"
		case ".jpeg", ".jpg":
			return "image/jpeg"
		case ".png":
			return "image/png"
		case ".svg":
			return "image/svg+xml"
		case ".tif", ".tiff":
			return "image/tiff"
		case ".webp":
			return "image/webp"
		}
	}
	return ""
}
