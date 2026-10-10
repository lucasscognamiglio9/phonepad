//go:build linux && phonepad_lab

package input

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bendahl/uinput"
	"github.com/godbus/dbus/v5"
)

type labKeyboard struct {
	conn    *dbus.Conn
	session dbus.BusObject
}

func newLabKeyboard(t *testing.T) *labKeyboard {
	t.Helper()
	conn, err := dbus.SessionBus()
	if err != nil {
		t.Fatalf("private session bus: %v", err)
	}
	root := conn.Object("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop")
	var path dbus.ObjectPath
	if err := root.Call("org.gnome.Mutter.RemoteDesktop.CreateSession", 0).Store(&path); err != nil {
		conn.Close()
		t.Fatalf("create private remote session: %v", err)
	}
	session := conn.Object("org.gnome.Mutter.RemoteDesktop", path)
	if err := session.Call("org.gnome.Mutter.RemoteDesktop.Session.Start", 0).Err; err != nil {
		conn.Close()
		t.Fatalf("start private remote session: %v", err)
	}
	return &labKeyboard{conn: conn, session: session}
}

func (k *labKeyboard) notify(key int, down bool) error {
	var keysym uint32
	switch key {
	case uinput.KeyLeftctrl:
		keysym = 0xffe3 // Control_L
	case uinput.KeyV:
		keysym = uint32('v')
	default:
		return fmt.Errorf("fixture key %d unsupported", key)
	}
	return k.session.Call("org.gnome.Mutter.RemoteDesktop.Session.NotifyKeyboardKeysym", 0, keysym, down).Err
}

func (k *labKeyboard) KeyPress(key int) error {
	if err := k.notify(key, true); err != nil {
		return err
	}
	return k.notify(key, false)
}
func (k *labKeyboard) KeyDown(key int) error         { return k.notify(key, true) }
func (k *labKeyboard) KeyUp(key int) error           { return k.notify(key, false) }
func (k *labKeyboard) FetchSyspath() (string, error) { return "private-mutter-session", nil }
func (k *labKeyboard) Close() error                  { return k.conn.Close() }

var _ uinput.Keyboard = (*labKeyboard)(nil)

func waitLabFile(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func traceLab(root, value string) {
	path := filepath.Join(root, "fallback-go-trace.log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintln(file, time.Now().Format(time.RFC3339Nano), value)
}

func TestLiteralClipboardFallbackLab(t *testing.T) {
	root := os.Getenv("PHONEPAD_HFR_ROOT")
	if root == "" {
		t.Skip("private HFR lab only")
	}
	if err := os.Setenv(clipboardFallbackShortcutEnv, "ctrl-v"); err != nil {
		t.Fatal(err)
	}
	waitLabFile(t, filepath.Join(root, "fallback-ready"), 10*time.Second)

	keyboard := newLabKeyboard(t)
	defer keyboard.Close()
	d := &uinputDevice{kbd: keyboard, held: make(map[int]struct{}), btns: make(map[string]bool)}
	focus := d.LiteralFocus(context.Background())
	if focus.State != "ready" || focus.Detail != "clipboard_fallback" || focus.Target != clipboardFallbackTarget {
		t.Fatalf("focus did not select explicit fallback: %+v", focus)
	}

	cases := []struct {
		name string
		text string
	}{
		{name: "slow", text: "¿_ símbolos ñ 👨‍👩‍👧‍👦\n" + "x" + "\t" + "_?"},
		{name: "external-same", text: "same-owner-bytes-¿_"},
		{name: "external-different", text: "must-not-restore"},
	}
	for index, tc := range cases {
		t.Logf("case %s start", tc.name)
		traceLab(root, tc.name+" request")
		request := map[string]string{"case": tc.name, "text": tc.text}
		payload, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		requestPath := filepath.Join(root, fmt.Sprintf("fallback-request-%d.json", index))
		if err := os.WriteFile(requestPath, payload, 0o600); err != nil {
			t.Fatal(err)
		}
		result := d.LiteralText(context.Background(), tc.text, clipboardFallbackTarget)
		t.Logf("case %s receipt: %+v", tc.name, result)
		traceLab(root, tc.name+" receipt "+result.Detail)
		if result.State != "uncertain" {
			t.Fatalf("%s receipt = %+v, want uncertain", tc.name, result)
		}
		resultPath := filepath.Join(root, fmt.Sprintf("fallback-result-%d.json", index))
		waitLabFile(t, resultPath, 5*time.Second)
		traceLab(root, tc.name+" result-file")
		var report struct {
			Case         string `json:"case"`
			Actual       string `json:"actual"`
			Expected     string `json:"expected"`
			Exact        bool   `json:"exact"`
			EditableText bool   `json:"editableText"`
		}
		data, err := os.ReadFile(resultPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &report); err != nil {
			t.Fatal(err)
		}
		if report.Case != tc.name || !report.Exact || report.Actual != report.Expected || report.EditableText {
			t.Fatalf("%s GTK fallback report = %+v", tc.name, report)
		}
		t.Logf("case %s consumer exact", tc.name)
	}
}
