package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordingClipboard struct {
	path      string
	kind      clipboardKind
	mediaType string
	data      []byte
	err       error
}

func (c *recordingClipboard) Copy(path string, kind clipboardKind, mediaType string) error {
	c.path, c.kind, c.mediaType = path, kind, mediaType
	c.data, _ = os.ReadFile(path)
	return c.err
}

func TestWLClipboardCopiesPNGBytesWithDeclaredMIME(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "image.png")
	var source bytes.Buffer
	pix := image.NewRGBA(image.Rect(0, 0, 2, 1))
	pix.SetRGBA(0, 0, color.RGBA{R: 0xff, A: 0xff})
	pix.SetRGBA(1, 0, color.RGBA{B: 0xff, A: 0xff})
	if err := png.Encode(&source, pix); err != nil {
		t.Fatal(err)
	}
	want := source.Bytes()
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	var gotType string
	var got []byte
	c := wlClipboard{copy: func(mediaType string, src io.Reader) error {
		gotType = mediaType
		var err error
		got, err = io.ReadAll(src)
		return err
	}}
	if err := c.Copy(path, clipboardImage, "image/png"); err != nil {
		t.Fatal(err)
	}
	if gotType != "image/png" {
		t.Fatalf("MIME = %q, want image/png", gotType)
	}
	decoded, err := png.Decode(bytes.NewReader(got))
	if err != nil {
		t.Fatalf("clipboard bytes are not PNG: %v", err)
	}
	if decoded.Bounds().Size() != (image.Point{X: 2, Y: 1}) {
		t.Fatalf("clipboard image size = %v, want 2x1", decoded.Bounds().Size())
	}
}

func TestWLClipboardConvertsJPEGToPNG(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "image.jpg")
	pix := image.NewRGBA(image.Rect(0, 0, 3, 2))
	pix.SetRGBA(1, 1, color.RGBA{R: 0xff, G: 0x10, A: 0xff})
	var source bytes.Buffer
	if err := jpeg.Encode(&source, pix, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, source.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	var gotType string
	var got []byte
	c := wlClipboard{copy: func(mediaType string, src io.Reader) error {
		gotType = mediaType
		var err error
		got, err = io.ReadAll(src)
		return err
	}}
	if err := c.Copy(path, clipboardImage, "image/jpeg"); err != nil {
		t.Fatal(err)
	}
	if gotType != "image/png" {
		t.Fatalf("clipboard MIME = %q, want image/png", gotType)
	}
	if _, err := png.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("clipboard bytes are not PNG: %v", err)
	}
}

func TestWLClipboardCopiesDocumentAsFileURI(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a file #1.txt")
	var gotType string
	var got string
	c := wlClipboard{copy: func(mediaType string, src io.Reader) error {
		gotType = mediaType
		data, err := io.ReadAll(src)
		got = string(data)
		return err
	}}
	if err := c.Copy(path, clipboardFile, "text/uri-list"); err != nil {
		t.Fatal(err)
	}
	if gotType != "text/uri-list" {
		t.Fatalf("MIME = %q, want text/uri-list", gotType)
	}
	want := (&url.URL{Scheme: "file", Path: filepath.Clean(path)}).String() + "\r\n"
	if got != want {
		t.Fatalf("URI = %q, want %q", got, want)
	}
}

func TestClipboardKindForOnlyAdvertisesSupportedImageBytes(t *testing.T) {
	for _, tc := range []struct {
		media string
		kind  clipboardKind
		mime  string
	}{
		{"image/png; charset=binary", clipboardImage, "image/png"},
		{"image/jpeg", clipboardImage, "image/png"},
		{"image/heic", clipboardImage, "image/png"},
		{"application/pdf", clipboardFile, "text/uri-list"},
	} {
		kind, mime := clipboardKindFor(tc.media)
		if kind != tc.kind || mime != tc.mime {
			t.Fatalf("clipboardKindFor(%q) = (%q, %q), want (%q, %q)", tc.media, kind, mime, tc.kind, tc.mime)
		}
	}
}

func TestParseEXIFOrientationAndRotateJPEGFallback(t *testing.T) {
	data := make([]byte, 8+2+12+4)
	copy(data, []byte("II"))
	binary.LittleEndian.PutUint16(data[2:4], 42)
	binary.LittleEndian.PutUint32(data[4:8], 8)
	binary.LittleEndian.PutUint16(data[8:10], 1)
	binary.LittleEndian.PutUint16(data[10:12], 0x0112)
	binary.LittleEndian.PutUint16(data[12:14], 3)
	binary.LittleEndian.PutUint32(data[14:18], 1)
	binary.LittleEndian.PutUint16(data[18:20], 6)
	orientation, ok := parseEXIFOrientation(data)
	if !ok || orientation != 6 {
		t.Fatalf("orientation = (%d, %t), want (6, true)", orientation, ok)
	}
	source := image.NewRGBA(image.Rect(0, 0, 2, 1))
	source.SetRGBA(0, 0, color.RGBA{R: 0xff, A: 0xff})
	source.SetRGBA(1, 0, color.RGBA{B: 0xff, A: 0xff})
	rotated := applyJPEGOrientation(source, orientation)
	if rotated.Bounds().Size() != (image.Point{X: 1, Y: 2}) {
		t.Fatalf("rotated size = %v, want 1x2", rotated.Bounds().Size())
	}
	if got := color.RGBAModel.Convert(rotated.At(0, 0)).(color.RGBA); got.R != 0xff || got.B != 0 {
		t.Fatalf("rotated top pixel = %#v, want red", got)
	}
	if got := color.RGBAModel.Convert(rotated.At(0, 1)).(color.RGBA); got.B != 0xff || got.R != 0 {
		t.Fatalf("rotated bottom pixel = %#v, want blue", got)
	}
}

func clipboardUploadRequest(t *testing.T, name, mediaType string, data []byte, intent bool) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if intent {
		if err := form.WriteField("intent", "clipboard"); err != nil {
			t.Fatal(err)
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	header.Set("Content-Type", mediaType)
	part, err := form.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "https://phone.example/api/files", &body)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("Origin", "https://phone.example")
	return r.WithContext(contextWithTrustedNode(r.Context()))
}

func TestClipboardUploadPublishesPNGAndDelegatesSavedBytes(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	clipboard := &recordingClipboard{}
	s.clipboard = clipboard
	want := []byte("\x89PNG\r\n\x1a\nactual bytes")
	w := httptest.NewRecorder()
	s.handleFiles(w, clipboardUploadRequest(t, "selected.png", "image/png", want, true))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if clipboard.kind != clipboardImage || clipboard.mediaType != "image/png" {
		t.Fatalf("clipboard call = (%q, %q), want (image, image/png)", clipboard.kind, clipboard.mediaType)
	}
	if !bytes.Equal(clipboard.data, want) {
		t.Fatalf("clipboard received %q, want %q", clipboard.data, want)
	}
	if filepath.Dir(clipboard.path) != s.uploadDir {
		t.Fatalf("clipboard path escaped upload directory: %q", clipboard.path)
	}
	if _, err := os.Stat(clipboard.path); err != nil {
		t.Fatalf("saved file missing: %v", err)
	}
	if !strings.Contains(w.Body.String(), `"clipboard":"ready"`) || !strings.Contains(w.Body.String(), `"clipboardKind":"image"`) {
		t.Fatalf("missing clipboard receipt: %s", w.Body.String())
	}
}

func TestClipboardUploadUsesFileKindAndReportsUnavailableWithoutLosingFile(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	clipboard := &recordingClipboard{err: errors.New("clipboard unavailable")}
	s.clipboard = clipboard
	w := httptest.NewRecorder()
	s.handleFiles(w, clipboardUploadRequest(t, "notes.pdf", "application/pdf", []byte("pdf"), true))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if clipboard.kind != clipboardFile || clipboard.mediaType != "text/uri-list" {
		t.Fatalf("clipboard call = (%q, %q), want (file, text/uri-list)", clipboard.kind, clipboard.mediaType)
	}
	if _, err := os.Stat(clipboard.path); err != nil {
		t.Fatalf("saved file missing after clipboard failure: %v", err)
	}
	if !strings.Contains(w.Body.String(), `"clipboard":"unavailable"`) || !strings.Contains(w.Body.String(), `"detail":`) {
		t.Fatalf("missing unavailable receipt: %s", w.Body.String())
	}
}

func TestLegacyUploadDoesNotTouchClipboardOrChangeReceipt(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	clipboard := &recordingClipboard{}
	s.clipboard = clipboard
	w := httptest.NewRecorder()
	s.handleFiles(w, clipboardUploadRequest(t, "legacy.txt", "text/plain", []byte("legacy"), false))
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if clipboard.path != "" {
		t.Fatal("legacy upload unexpectedly touched clipboard")
	}
	if strings.Contains(w.Body.String(), "clipboard") {
		t.Fatalf("legacy receipt changed: %s", w.Body.String())
	}
}

func contextWithTrustedNode(ctx context.Context) context.Context {
	return context.WithValue(ctx, trustedNodeKey{}, true)
}
