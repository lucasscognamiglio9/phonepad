// This file is copied into the isolated adab7c77 archive by
// compat_interop_test.go.  It intentionally never enters the production
// daemon: the archive is the server-v1 half of the real compatibility test.
package server

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"phonepad/daemon/internal/input"
)

type p02CompatAuth string

func (a p02CompatAuth) Valid(token string) bool { return token == string(a) }
func (a p02CompatAuth) MarkPaired() error       { return nil }
func (a p02CompatAuth) Paired() bool            { return true }

type p02CompatProbe struct {
	mu      sync.Mutex
	moves   [][2]int
	buttons []p02CompatButton
}

type p02CompatButton struct {
	button string
	down   bool
}

func (p *p02CompatProbe) Move(dx, dy int) {
	p.mu.Lock()
	p.moves = append(p.moves, [2]int{dx, dy})
	p.mu.Unlock()
}
func (p *p02CompatProbe) Button(button string, down bool) {
	p.mu.Lock()
	p.buttons = append(p.buttons, p02CompatButton{button: button, down: down})
	p.mu.Unlock()
}
func (p *p02CompatProbe) Scroll(int, int)        {}
func (p *p02CompatProbe) Text(string)            {}
func (p *p02CompatProbe) Special(string)         {}
func (p *p02CompatProbe) Combo([]string, string) {}
func (p *p02CompatProbe) Gesture(string)         {}
func (p *p02CompatProbe) Touch([]input.Contact)  {}
func (p *p02CompatProbe) Close()                 {}

func TestP02CompatOldServer(t *testing.T) {
	script := os.Getenv("PHONEPAD_COMPAT_CLIENT_SCRIPT")
	tsRoot := os.Getenv("PHONEPAD_COMPAT_TS_ROOT")
	if script == "" || tsRoot == "" {
		t.Skip("compatibility harness variables are unset")
	}
	probe := &p02CompatProbe{}
	s := New(p02CompatAuth("tok"), probe, nil, "")
	ts := httptest.NewTLSServer(s.Handler())
	defer ts.Close()
	ca := filepath.Join(t.TempDir(), "compat-ca.pem")
	cert, err := x509.ParseCertificate(ts.Certificate().Raw)
	if err != nil {
		t.Fatalf("parse httptest certificate: %v", err)
	}
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0600); err != nil {
		t.Fatalf("write loopback CA: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", script, ts.URL, "__Host-phonepad=tok", tsRoot, "current-to-stable")
	cmd.Env = append(os.Environ(), "NODE_EXTRA_CA_CERTS="+ca)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatalf("current TypeScript against archived Go server: %v", err)
	}
	p02CompatAssertEvents(t, probe)
}

func p02CompatAssertEvents(t *testing.T, probe *p02CompatProbe) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		probe.mu.Lock()
		moves := append([][2]int(nil), probe.moves...)
		buttons := append([]p02CompatButton(nil), probe.buttons...)
		probe.mu.Unlock()
		if len(moves) >= 2 && len(buttons) >= 4 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	probe.mu.Lock()
	defer probe.mu.Unlock()
	wantMoves := [][2]int{{7, -3}, {-2, 5}}
	wantButtons := []p02CompatButton{
		{button: "l", down: true}, {button: "l", down: false},
		{button: "r", down: true}, {button: "r", down: false},
	}
	if fmt.Sprint(probe.moves) != fmt.Sprint(wantMoves) {
		t.Fatalf("moves = %v, want %v (reconnect replay or loss)", probe.moves, wantMoves)
	}
	if fmt.Sprint(probe.buttons) != fmt.Sprint(wantButtons) {
		t.Fatalf("buttons = %v, want %v (reconnect replay or loss)", probe.buttons, wantButtons)
	}
}
