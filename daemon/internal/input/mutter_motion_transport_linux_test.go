//go:build linux

package input

import (
	"bufio"
	"context"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

type pointerWireFixture struct {
	mu      sync.Mutex
	buttons []bool
	moves   int
}

func (f *pointerWireFixture) NotifyPointerButton(button int32, down bool) *dbus.Error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if button != 0x110 {
		return dbus.MakeFailedError(ErrProviderUnavailable)
	}
	f.buttons = append(f.buttons, down)
	return nil
}
func (f *pointerWireFixture) NotifyPointerMotionRelative(x, y float64) *dbus.Error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.moves++
	return nil
}
func (f *pointerWireFixture) Stop() *dbus.Error { return nil }
func TestMutterPointerWireContract(t *testing.T) {
	binary, err := exec.LookPath("dbus-daemon")
	if err != nil {
		t.Skip("dbus-daemon unavailable; private GTK lab covers this contract")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "--session", "--nofork", "--print-address=1")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	address, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	server, err := dbus.Connect(strings.TrimSpace(address))
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := dbus.Connect(strings.TrimSpace(address))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	name := "app.phonepad.PointerWireTest"
	if _, err := server.RequestName(name, dbus.NameFlagDoNotQueue); err != nil {
		t.Fatal(err)
	}
	fixture := &pointerWireFixture{}
	path := dbus.ObjectPath("/app/phonepad/PointerWireTest")
	iface := mutterRemoteDesktop + ".Session"
	if err := server.Export(fixture, path, iface); err != nil {
		t.Fatal(err)
	}
	p := &mutterMotion{conn: client, session: client.Object(name, path)}
	// Prove the bus rejects the old (iu) encoding, then run the real methods.
	if err := p.session.CallWithContext(ctx, iface+".NotifyPointerButton", 0, int32(0x110), uint32(1)).Err; err == nil {
		t.Fatal("fixture accepted incompatible button state")
	}
	for i := 0; i < 2; i++ {
		if err := p.Button(true); err != nil {
			t.Fatal(err)
		}
		if err := p.Button(false); err != nil {
			t.Fatal(err)
		}
		if err := p.Move(.125, -.125); err != nil {
			t.Fatal(err)
		}
	}
	// Failure must still permit a release; it must not replay movement.
	p.failed = true
	if err := p.Button(false); err != nil {
		t.Fatal(err)
	}
	if err := p.Move(1, 0); err == nil {
		t.Fatal("failed provider accepted movement")
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if !reflect.DeepEqual(fixture.buttons, []bool{true, false, true, false, false}) || fixture.moves != 2 {
		t.Fatalf("buttons=%v moves=%d", fixture.buttons, fixture.moves)
	}
}
