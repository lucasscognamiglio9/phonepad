//go:build linux

package input

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

// The observer must exclusively EVIOCGRAB this newly-created device before
// signalling start. It never observes physical input or drives GNOME.
func TestNativeTouchpadFixture(t *testing.T) {
	dir := os.Getenv("PHONEPAD_MT_FIXTURE_DIR")
	if dir == "" {
		t.Skip("native libinput fixture test is opt-in")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, "start"))
	m, err := newMTTouchpad()
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	var name [256]byte
	if err := ioctl(uintptr(m.fd), 0x8100552c, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		t.Fatal(err)
	}
	sysname := strings.TrimRight(string(name[:]), "\x00")
	var paths []string
	for i := 0; i < 100; i++ {
		paths, _ = filepath.Glob(filepath.Join("/sys/devices/virtual/input", sysname, "event*"))
		if len(paths) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(paths) != 1 {
		t.Fatal("new virtual event node missing")
	}
	device := filepath.Join("/dev/input", filepath.Base(paths[0]))
	data, _ := json.Marshal(map[string]string{"device": device, "sysname": sysname})
	if err := os.WriteFile(filepath.Join(dir, "device.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("READY isolated native touchpad")
	deadline := time.Now().Add(60 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "start")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("observer did not exclusively grab fixture")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stage := func(name string, action func()) {
		if err := os.WriteFile(filepath.Join(dir, "stage"), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
		action()
		time.Sleep(600 * time.Millisecond)
	}
	one := []Contact{{ID: 1, X: .45, Y: .4}}
	two := []Contact{{ID: 1, X: .4, Y: .4}, {ID: 2, X: .6, Y: .4}}
	stage("tap", func() { m.touch(one); time.Sleep(60 * time.Millisecond); m.touch(nil) })
	stage("right_tap", func() { m.touch(two); time.Sleep(60 * time.Millisecond); m.touch(nil) })
	stage("cancel_one", func() { m.touch(one); time.Sleep(60 * time.Millisecond); m.reset() })
	stage("cancel_two", func() { m.touch(two); time.Sleep(60 * time.Millisecond); m.reset() })
	for _, cancel := range []bool{false, true} {
		name := "double_tap_drag"
		if cancel {
			name = "cancel_drag"
		}
		stage(name, func() {
			m.touch(one)
			time.Sleep(60 * time.Millisecond)
			m.touch(nil)
			time.Sleep(80 * time.Millisecond)
			m.touch(one)
			for i := 1; i <= 30; i++ {
				time.Sleep(8 * time.Millisecond)
				m.touch([]Contact{{ID: 1, X: .45 + float64(i)*.005, Y: .4}})
			}
			if cancel {
				m.reset()
			} else {
				m.touch(nil)
			}
		})
	}
	stage("scroll", func() {
		m.touch(two)
		for i := 1; i <= 30; i++ {
			time.Sleep(8 * time.Millisecond)
			m.touch([]Contact{{ID: 1, X: .4, Y: .4 + float64(i)*.007}, {ID: 2, X: .6, Y: .4 + float64(i)*.007}})
		}
		m.touch(nil)
	})
	stage("pinch", func() {
		m.touch(two)
		for i := 1; i <= 30; i++ {
			time.Sleep(8 * time.Millisecond)
			m.touch([]Contact{{ID: 1, X: .4 - float64(i)*.005, Y: .4}, {ID: 2, X: .6 + float64(i)*.005, Y: .4}})
		}
		m.touch(nil)
	})
	stage("swipe", func() {
		m.touch([]Contact{{ID: 1, X: .3, Y: .5}, {ID: 2, X: .5, Y: .5}, {ID: 3, X: .7, Y: .5}})
		for i := 1; i <= 30; i++ {
			time.Sleep(8 * time.Millisecond)
			m.touch([]Contact{{ID: 1, X: .3, Y: .5 - float64(i)*.006}, {ID: 2, X: .5, Y: .5 - float64(i)*.006}, {ID: 3, X: .7, Y: .5 - float64(i)*.006}})
		}
		m.touch(nil)
	})
	_ = os.WriteFile(filepath.Join(dir, "done"), []byte("done"), 0600)
	time.Sleep(200 * time.Millisecond)
}
