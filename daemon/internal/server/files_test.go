package server

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"phonepad/daemon/internal/privatefs"
)

func TestPrivateFileTransfer(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	request := func(name, content, origin string, auth, complete bool) *httptest.ResponseRecorder {
		var b bytes.Buffer
		form := multipart.NewWriter(&b)
		p, _ := form.CreateFormFile("file", name)
		io.WriteString(p, content)
		if complete {
			form.Close()
		}
		r := httptest.NewRequest("POST", "https://phone.example/api/files", &b)
		r.Header.Set("Content-Type", form.FormDataContentType())
		r.Header.Set("Origin", origin)
		if auth {
			r = r.WithContext(context.WithValue(r.Context(), trustedNodeKey{}, true))
		}
		w := httptest.NewRecorder()
		s.handleFiles(w, r)
		return w
	}
	for _, tc := range []struct {
		origin string
		auth   bool
		code   int
	}{{"https://phone.example", false, 401}, {"https://evil.example", true, 403}, {"", true, 403}} {
		if w := request("a.txt", "private", tc.origin, tc.auth, true); w.Code != tc.code {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := request("../../original.txt", "hello", "https://phone.example", true, true); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request("../../original.txt", "second", "https://phone.example", true, true); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	files, _ := os.ReadDir(s.uploadDir)
	if len(files) != 2 {
		t.Fatal("duplicate overwrote a file")
	}
	for _, f := range files {
		if !strings.HasPrefix(f.Name(), "original-") {
			t.Fatal("unsafe name", f.Name())
		}
		private, err := privatefs.IsPrivate(filepath.Join(s.uploadDir, f.Name()), false)
		if err != nil || !private {
			t.Fatal("attachment not private")
		}
	}
	if w := request("truncated.txt", "partial", "https://phone.example", true, false); w.Code != 400 {
		t.Fatal("partial accepted", w.Code)
	}
	files, _ = os.ReadDir(s.uploadDir)
	if len(files) != 2 {
		t.Fatal("partial file left behind")
	}
	s.uploadMu.Lock()
	w := request("busy.txt", "busy", "https://phone.example", true, true)
	s.uploadMu.Unlock()
	if w.Code != 429 {
		t.Fatal("concurrent upload accepted")
	}
	if _, err := os.Stat(filepath.Join(s.uploadDir, "..", "original.txt")); !os.IsNotExist(err) {
		t.Fatal("escaped storage folder")
	}
}

func TestFileTransferGatewayRequiresPinnedDevice(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	r := localRequest("POST", "https://phone.example/api/files")
	r.Header.Set("Origin", "https://phone.example")
	w := httptest.NewRecorder()
	s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("non-pinned device reached transfer", w.Code)
	}
	s.trustedPeer = func(*http.Request) bool { return true }
	w = httptest.NewRecorder()
	s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("pinned device cannot reach transfer", w.Code)
	}
}

func TestPrivateFileTransferRejectsRevokedFilesWithoutPublishing(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.uploadDir = t.TempDir()
	s.clipboard = &recordingClipboard{}
	if err := s.SetPermissions(mutationPermissions("revoked", "granted")); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleFiles(w, clipboardUploadRequest(t, "revoked.txt", "text/plain", []byte("private"), false))
	if w.Code != http.StatusForbidden {
		t.Fatalf("revoked file upload status = %d, body = %s", w.Code, w.Body.String())
	}
	entries, err := os.ReadDir(s.uploadDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("revoked file upload published %d entries", len(entries))
	}
}
