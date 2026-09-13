package server

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var previewClient = &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 10 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "phonepad-preview", "capture.sock"))
}}}

func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	rtc := r.URL.Path == "/api/preview/rtc"
	if (rtc && r.Method != "POST") || (!rtc && r.Method != "GET") {
		http.Error(w, "method", 405)
		return
	}
	var body io.Reader
	if rtc {
		if !sameOrigin(r) {
			http.Error(w, "origin", 403)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "json required", 415)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
		if err != nil {
			http.Error(w, "body too large", 413)
			return
		}
		body = bytes.NewReader(data)
	}
	path := "/status"
	if rtc {
		path = "/rtc"
	} else if r.URL.Path == "/api/preview/video" {
		path = "/video"
	} else if r.URL.Path != "/api/preview/status" {
		http.NotFound(w, r)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), r.Method, "http://preview"+path, body)
	if rtc {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := previewClient.Do(req)
	if err != nil {
		http.Error(w, `{"state":"unavailable"}`, 503)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	buf := make([]byte, 64*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, e := w.Write(buf[:n]); e != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if err != nil {
			if err != io.EOF {
				return
			}
			break
		}
	}
}
