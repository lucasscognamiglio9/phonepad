//go:build linux && phonepad_lab

package input

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Called while the production capture has added its virtual mirror. It reads
// the same provider contract sent to the phone, without injecting any input.
func TestMutterPredictionContractLab(t *testing.T) {
	root := os.Getenv("PHONEPAD_HFR_ROOT")
	if !strings.HasPrefix(root, "/tmp/phonepad-hfr-") || !strings.Contains(os.Getenv("DBUS_SESSION_BUS_ADDRESS"), root) {
		t.Skip("private compositor required")
	}
	t.Setenv("XDG_CURRENT_DESKTOP", "GNOME")
	motion, err := newMutterMotion()
	if err != nil {
		t.Fatal(err)
	}
	defer motion.Close()
	device := &uinputDevice{motion: motion, linear: &linearTouch{}}
	scale, err := strconv.ParseFloat(os.Getenv("PHONEPAD_LAB_SCALE"), 64)
	if err != nil {
		t.Fatal(err)
	}
	contract, available := device.PointerPrediction()
	if !available || contract.PixelsPerMM != linearPixelsPerMM*scale {
		t.Fatalf("capture mirror contract unavailable: %+v %v", contract, available)
	}
	stamp, available := device.PointerFence()
	if !available || stamp == 0 {
		t.Fatal("capture mirror execution fence unavailable")
	}
	data, _ := json.Marshal(contract)
	if err := os.WriteFile(filepath.Join(root, "prediction-contract.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

// This exercises production contact recognition and the real Mutter D-Bus
// codec, then verifies GTK received the clicks, movement and releases.
// It must never target the user's compositor or physical input devices.
func TestMutterPointerLab(t *testing.T) {
	root := os.Getenv("PHONEPAD_HFR_ROOT")
	if !strings.HasPrefix(root, "/tmp/phonepad-hfr-") || !strings.Contains(os.Getenv("DBUS_SESSION_BUS_ADDRESS"), root) {
		t.Skip("private compositor required")
	}
	waitLabFile(t, filepath.Join(root, "pointer-ready"), 10*time.Second)
	t.Setenv("XDG_CURRENT_DESKTOP", "GNOME")
	motion, err := newMutterMotion()
	if err != nil {
		t.Fatal(err)
	}
	defer motion.Close()
	device := &uinputDevice{motion: motion, linear: &linearTouch{}}
	scale := 1.0
	if configured := os.Getenv("PHONEPAD_LAB_SCALE"); configured != "" {
		scale, err = strconv.ParseFloat(configured, 64)
		if err != nil {
			t.Fatal(err)
		}
	}
	contract, available := device.PointerPrediction()
	if !available || contract.PixelsPerMM != 20*scale || contract.Width != 1920 || contract.Height != 1080 {
		t.Fatalf("private native contract unavailable: %+v %v", contract, available)
	}
	stamp, available := device.PointerFence()
	if !available || stamp == 0 {
		t.Fatal("native monotonic fence unavailable")
	}
	later, _ := device.PointerFence()
	if later < stamp {
		t.Fatal("native fence clock regressed")
	}
	t.Logf("native prediction contract: %v pixels/mm; monotonic fence validated", contract.PixelsPerMM)

	// Close the isolated shell overview and position within our fixture.
	for _, down := range []bool{true, false} {
		if err := motion.call("NotifyKeyboardKeysym", uint32(0xff1b), down); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(500 * time.Millisecond)
	if err := motion.Move(.125, .125); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := motion.Move(-10000, -10000); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := motion.Move(960/scale, 540/scale); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	snapshot := func(name string) []map[string]interface{} {
		t.Helper()
		data, _ := json.Marshal(map[string]string{"case": name})
		if err := os.WriteFile(filepath.Join(root, "pointer-request.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, "pointer-result-"+name+".json")
		waitLabFile(t, path, 3*time.Second)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var events []map[string]interface{}
		if err := json.Unmarshal(data, &events); err != nil {
			t.Fatal(err)
		}
		return events
	}
	initial := snapshot("position")
	var lastX float64
	foundPosition := false
	for _, e := range initial {
		if e["kind"] == "motion" {
			lastX = e["x"].(float64)
			foundPosition = true
		}
	}
	if !foundPosition {
		t.Fatal("initial GTK cursor position unavailable")
	}

	p := &linearTouch{move: motion.Move, button: motion.Button, multiTouch: func([]Contact) {}, cancelMulti: func() {}}
	g := PointerGeometry{Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70}
	clock := time.Now()
	frame := func(c []Contact) {
		p.frame(c, g, clock)
		clock = clock.Add(40 * time.Millisecond)
		time.Sleep(40 * time.Millisecond)
	}
	c := Contact{ID: 1, X: .5, Y: .5}
	for _, name := range []string{"single", "double", "drag", "cancel", "repeat-double"} {
		p.lastTap = time.Time{}
		frame([]Contact{c})
		frame(nil)
		expected := 1
		if name != "single" {
			expected = 2
			frame([]Contact{c})
			if name == "drag" || name == "cancel" {
				moved := c
				moved.X += .02
				frame([]Contact{moved})
			}
			if name == "cancel" {
				p.cancel()
			}
			frame(nil)
		}
		// Let the deliberate double-tap drag window elapse before the next
		// independent motion, which must not become a third button press.
		clock = clock.Add(400 * time.Millisecond)
		time.Sleep(400 * time.Millisecond)
		// Crucially, pointer motion must still arrive AFTER each click sequence.
		frame([]Contact{c})
		moved := c
		moved.X += .015
		frame([]Contact{moved})
		frame(nil)
		time.Sleep(100 * time.Millisecond)
		events := snapshot(name)
		pressed, released, moves := 0, 0, 0
		for _, e := range events {
			switch e["kind"] {
			case "pressed":
				pressed++
			case "released":
				released++
			case "motion":
				moves++
			}
		}
		if pressed != expected || released != expected || moves == 0 || p.blocked || motion.failed {
			t.Fatalf("%s: pressed=%d released=%d motion=%d blocked=%v nativeFailed=%v events=%v", name, pressed, released, moves, p.blocked, motion.failed, events)
		}
		var finalX float64
		for _, e := range events {
			if e["kind"] == "motion" {
				finalX = e["x"].(float64)
			}
		}
		expectedDelta := 30.0
		if name == "drag" || name == "cancel" {
			expectedDelta += 40
		}
		if math.Abs(finalX-lastX-expectedDelta) > 1 {
			t.Fatalf("native prediction mismatch: got delta %.3f want %.3f", finalX-lastX, expectedDelta)
		}
		lastX = finalX
		t.Logf("%s: GTK received %d presses, %d releases, %d moves; cursor remains active", name, pressed, released, moves)
	}
	if err := os.WriteFile(filepath.Join(root, "pointer-done"), nil, 0600); err != nil {
		t.Fatal(err)
	}
}
