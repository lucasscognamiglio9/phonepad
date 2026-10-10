package server

import (
	"context"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in because this check also needs the mobile npm dependencies. It runs
// the production TypeScript connection and literal transfer over real HTTPS
// and WebSocket transports, with synthetic input and no physical devices.
func TestMobileSessionInterop(t *testing.T) {
	script := os.Getenv("PHONEPAD_MOBILE_INTEROP")
	if script == "" {
		t.Skip("set PHONEPAD_MOBILE_INTEROP to tools/refactor/p02_session_interop.cjs")
	}
	// Produce metadata with the actual Python provider model, so the Go and
	// TypeScript parsers cannot silently drift into independent fixture formats.
	pythonContext, cancelPython := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelPython()
	python := exec.CommandContext(pythonContext, "python3", "-c", `import json
from media_contract import MediaTracker
tracker = MediaTracker('portal')
tracker.begin_source('interop-source')
tracker.update_geometry(capture=(2731, 1537), encoded=(1920, 1080))
tracker.set_codecs(['H264'], selected='H264')
print(json.dumps({'state': 'ready', 'media': tracker.snapshot()}))`)
	python.Env = append(os.Environ(), "PYTHONPATH="+filepath.Join(filepath.Dir(script), "../../setup/preview"))
	metadata, err := python.Output()
	if err != nil {
		t.Fatalf("Python media contract: %v", err)
	}
	oldPreviewClient := previewClient
	defer func() { previewClient = oldPreviewClient }()
	previewClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(string(metadata)))}, nil
	})}
	probe := &literalProbe{target: strings.Repeat("a", 64), outcome: "dispatched"}
	s := New(staticAuth("tok"), probe, nil, "")
	mux := http.NewServeMux()
	mux.HandleFunc("/fixture/permission", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !s.auth.Valid(sessionToken(r)) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		permissions := defaultPermissions(probe)
		if r.URL.Query().Get("revoke") == "1" {
			permissions.Input = Permission{State: "revoked"}
		}
		if err := s.SetPermissions(permissions); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", s.Handler())
	ts := httptest.NewTLSServer(mux)
	defer ts.Close()
	certificate := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(certificate, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ts.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", script, ts.URL, sessionCookieName+"=tok")
	cmd.Env = append(os.Environ(), "NODE_EXTRA_CA_CERTS="+certificate)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatalf("mobile/Go interop: %v", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(probe.literals) != 2 || probe.literals[0] != strings.Repeat("¿Pregunta_? 👨‍👩‍👧‍👦 e\u0301\r\n", 900) || probe.literals[1] != "Texto después de reconectar" {
		t.Fatal("literal transfer was truncated, changed, duplicated, or omitted")
	}
}
