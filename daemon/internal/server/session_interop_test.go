package server

import (
	"context"
	"encoding/pem"
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
