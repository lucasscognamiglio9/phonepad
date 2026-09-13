package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeUpdateDownloadIsPrivateAndResumable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "candidate.ipa")
	content := "complete-native-build-test"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example", WithNativeUpdate(path))
	s.trustedPeer = func(r *http.Request) bool { return r.Header.Get("X-Forwarded-For") == "100.118.23.97" }
	for _, tc := range []struct {
		name, method, device, origin, byteRange string
		status                                  int
		body                                    string
	}{
		{"unpaired", "GET", "100.1.2.3", "", "", 401, "unauthorized\n"},
		{"download", "GET", "100.118.23.97", "", "", 200, content},
		{"resume", "GET", "100.118.23.97", "", "bytes=9-", 206, content[9:]},
		{"metadata", "HEAD", "100.118.23.97", "", "", 200, ""},
		{"no-write", "POST", "100.118.23.97", "", "", 405, "method\n"},
		{"cross-origin", "GET", "100.118.23.97", "https://evil.example", "", 403, "origin\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := localRequest(tc.method, "https://phone.example"+nativeUpdateRoute)
			r.Header.Set("X-Forwarded-For", tc.device)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Range", tc.byteRange)
			w := httptest.NewRecorder()
			s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
			if w.Code != tc.status || w.Body.String() != tc.body {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
			if tc.status == 200 || tc.status == 206 {
				if w.Header().Get("Content-Disposition") != `attachment; filename="Phonepad.ipa"` || w.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatal("download headers missing", w.Header())
				}
			}
		})
	}
	// Headers are trusted only at the dedicated gateway, not at the direct server.
	r := localRequest("GET", "https://phone.example"+nativeUpdateRoute)
	r.Header.Set("X-Forwarded-For", "100.118.23.97")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("direct request bypassed auth", w.Code)
	}
	for _, route := range []string{"/api/update/", "/api/update/other.ipa", "/api/update/../pair", "/api/update/Phonepad.ipa/anything"} {
		r := localRequest("GET", "https://phone.example"+route)
		r.Header.Set("X-Forwarded-For", "100.118.23.97")
		w := httptest.NewRecorder()
		s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("unexpected download route available %s: %d", route, w.Code)
		}
	}
}

func TestNativeUpdateUnavailableDoesNotExposePath(t *testing.T) {
	for _, path := range []string{"", filepath.Join(t.TempDir(), "absent.ipa"), t.TempDir()} {
		s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example", WithNativeUpdate(path))
		r := localRequest("GET", "https://phone.example"+nativeUpdateRoute)
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "secret"})
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 404 || (path != "" && strings.Contains(w.Body.String(), path)) {
			t.Fatal("missing release exposed filesystem", w.Code, w.Body.String())
		}
	}
}
