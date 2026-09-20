package server

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	"phonepad/daemon/internal/input"
)

// This is an opt-in, two-process compatibility check.  The current server
// half runs in this package; the old server half is copied into a git archive
// at adab7c77 and runs its own isolated Go test.  Keeping the old source out
// of the production module makes accidental cross-version imports impossible.
func TestP02Compatibility(t *testing.T) {
	if os.Getenv("PHONEPAD_COMPAT_INTEROP") != "1" {
		t.Skip("set PHONEPAD_COMPAT_INTEROP=1 for the focal cross-version check")
	}
	script := compatPath(t, os.Getenv("PHONEPAD_COMPAT_CLIENT_SCRIPT"), "tools/refactor/p02_compat_connection.cjs")
	archive := compatPath(t, os.Getenv("PHONEPAD_COMPAT_ARCHIVE"), "outputs/temporal/p02-07-compat/adab7c77")
	if _, err := os.Stat(filepath.Join(archive, "daemon", "go.mod")); err != nil {
		t.Fatalf("stable archive unavailable at %s: %v (run p02_compat_run.sh first)", archive, err)
	}

	t.Run("stable_ts_current_go", func(t *testing.T) {
		probe := &p02CompatProbe{}
		s := New(staticAuth("tok"), probe, nil, "")
		ts := httptest.NewTLSServer(s.Handler())
		defer ts.Close()
		ca := compatCA(t, ts)
		stableTS := filepath.Join(archive, "mobile", "src", "lib")
		runCompatNode(t, script, ts.URL, ca, stableTS, "stable-to-current")
		assertCompatEvents(t, probe)
	})

	t.Run("current_ts_stable_go", func(t *testing.T) {
		injectOldHarness(t, archive)
		goBin := os.Getenv("PHONEPAD_COMPAT_GO")
		if goBin == "" {
			goBin = "go"
		}
		currentTS := compatPath(t, "", "mobile/src/lib")
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, goBin, "test", "-mod=vendor", "./internal/server",
			"-run", "^TestP02CompatOldServer$", "-count=1")
		cmd.Dir = filepath.Join(archive, "daemon")
		cmd.Env = append(os.Environ(),
			"PHONEPAD_COMPAT_CLIENT_SCRIPT="+script,
			"PHONEPAD_COMPAT_TS_ROOT="+currentTS,
			"GOPROXY=off",
		)
		output, err := cmd.CombinedOutput()
		t.Log(string(output))
		if err != nil {
			t.Fatalf("current TypeScript against archived Go server: %v", err)
		}
	})
}

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

var _ input.Injector = (*p02CompatProbe)(nil)

func compatPath(t *testing.T, value, relative string) string {
	t.Helper()
	if value != "" {
		path, err := filepath.Abs(value)
		if err != nil {
			t.Fatal(err)
		}
		return path
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	return filepath.Join(root, relative)
}

func compatCA(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	cert, err := x509.ParseCertificate(ts.Certificate().Raw)
	if err != nil {
		t.Fatalf("parse httptest certificate: %v", err)
	}
	path := filepath.Join(t.TempDir(), "compat-ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0600); err != nil {
		t.Fatalf("write loopback CA: %v", err)
	}
	return path
}

func runCompatNode(t *testing.T, script, origin, ca, sourceRoot, mode string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", script, origin, "__Host-phonepad=tok", sourceRoot, mode)
	cmd.Env = append(os.Environ(), "NODE_EXTRA_CA_CERTS="+ca)
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatalf("cross-version TypeScript client %s: %v", mode, err)
	}
}

func injectOldHarness(t *testing.T, archive string) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	harness, err := os.ReadFile(filepath.Join(root, "tools/refactor/p02_compat_old_server_test.go"))
	if err != nil {
		t.Fatalf("read archived server harness: %v", err)
	}
	destination := filepath.Join(archive, "daemon/internal/server/compat_interop_test.go")
	if err := os.WriteFile(destination, harness, 0600); err != nil {
		t.Fatalf("write isolated old server harness: %v", err)
	}
}

func assertCompatEvents(t *testing.T, probe *p02CompatProbe) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	wantMoves := [][2]int{{7, -3}, {-2, 5}}
	wantButtons := []p02CompatButton{
		{button: "l", down: true}, {button: "l", down: false},
		{button: "r", down: true}, {button: "r", down: false},
	}
	for time.Now().Before(deadline) {
		probe.mu.Lock()
		moves := append([][2]int(nil), probe.moves...)
		buttons := append([]p02CompatButton(nil), probe.buttons...)
		probe.mu.Unlock()
		if reflect.DeepEqual(moves, wantMoves) && reflect.DeepEqual(buttons, wantButtons) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if !reflect.DeepEqual(probe.moves, wantMoves) {
		t.Errorf("moves = %v, want %v (reconnect replay or loss)", probe.moves, wantMoves)
	}
	if !reflect.DeepEqual(probe.buttons, wantButtons) {
		t.Errorf("buttons = %v, want %v (reconnect replay or loss)", probe.buttons, wantButtons)
	}
	if len(probe.moves) > len(wantMoves) || len(probe.buttons) > len(wantButtons) {
		t.Errorf("extra events indicate replay: moves=%v buttons=%v", probe.moves, probe.buttons)
	}
}
