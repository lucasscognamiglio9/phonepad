package server

import (
	"net/http"
	"os"
	"time"
)

const nativeUpdateRoute = "/api/update/Phonepad.ipa"

// WithNativeUpdate serves exactly one operator-selected build through the
// existing private authorization. No directory browsing, signing or keys.
func WithNativeUpdate(path string) Option {
	return func(s *Server) { s.nativeUpdatePath = path }
}

func (s *Server) handleNativeUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if s.nativeUpdatePath == "" {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(s.nativeUpdatePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="Phonepad.ipa"`)
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Minute))
	// ServeContent streams the file and supports resuming an interrupted download.
	http.ServeContent(w, r, "Phonepad.ipa", info.ModTime(), file)
}
