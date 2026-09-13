package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in only. Publishes fixtures created here, never reads the preexisting
// clipboard. A real desktop browser must paste and validate each ready fixture
// before its corresponding *.pasted marker is created by the verifier.
func TestDesktopClipboardFixture(t *testing.T) {
	dir := os.Getenv("PHONEPAD_CLIPBOARD_FIXTURE_DIR")
	if dir == "" {
		t.Skip("desktop clipboard fixture test is opt-in")
	}
	if !filepath.IsAbs(dir) {
		t.Fatal("fixture directory must be absolute")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s := New(staticAuth("test-only"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = filepath.Join(dir, "received")
	s.clipboard = systemClipboard()
	if c, ok := s.clipboard.(*desktopClipboard); ok {
		t.Cleanup(c.gtk.stop)
	}
	picture := image.NewRGBA(image.Rect(0, 0, 120, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 120; x++ {
			picture.Set(x, y, color.RGBA{uint8(x * 2), uint8(y * 3), 160, 255})
		}
	}
	var photo bytes.Buffer
	if err := jpeg.Encode(&photo, picture, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		key, name, mime string
		data            []byte
	}{
		{"image", "Phonepad-prueba.jpg", "image/jpeg", photo.Bytes()},
		{"document", "Phonepad-prueba.txt", "text/plain", []byte("Adjunto de prueba Phonepad. Sin datos personales.\n")},
	} {
		marker := filepath.Join(dir, fixture.key+".pasted")
		_ = os.Remove(marker)
		w := httptest.NewRecorder()
		s.handleFiles(w, clipboardUploadRequest(t, fixture.name, fixture.mime, fixture.data, true))
		var receipt map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
		if w.Code != 201 || receipt["clipboard"] != "ready" {
			t.Fatalf("clipboard fixture failed: %s", w.Body.String())
		}
		savedPath := filepath.Join(s.uploadDir, receipt["name"].(string))
		expected := fixture.data
		if fixture.key == "image" {
			pngPath, cleanup, err := clipboardPNG(savedPath)
			if err != nil {
				t.Fatal(err)
			}
			expected, err = os.ReadFile(pngPath)
			cleanup()
			if err != nil {
				t.Fatal(err)
			}
		}
		sum := sha256.Sum256(expected)
		report, _ := json.MarshalIndent(map[string]any{"receipt": receipt, "sha256": hex.EncodeToString(sum[:]), "bytes": len(expected)}, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, fixture.key+".ready.json"), report, 0600); err != nil {
			t.Fatal(err)
		}
		t.Logf("READY %s", fixture.key)
		deadline := time.Now().Add(120 * time.Second)
		for {
			if _, err := os.Stat(marker); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("no verified real paste for %s", fixture.key)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}
