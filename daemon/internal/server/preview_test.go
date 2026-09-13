package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewAuthorizationAndProxy(t *testing.T) {
	old := previewClient
	defer func() { previewClient = old }()
	calls := 0
	previewClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"video/mp4"}}, Body: io.NopCloser(strings.NewReader("test-video"))}, nil
	})}
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	r := localRequest("GET", "/api/preview/video")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 401 || calls != 0 {
		t.Fatal("unauthenticated capture accessed")
	}
	r = localRequest("GET", "/api/preview/video")
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "secret"})
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "test-video" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("video proxy failed")
	}
	s.trustedPeer = func(*http.Request) bool { return true }
	r = localRequest("GET", "https://phone.example/api/preview/video")
	r.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
	if w.Code != 403 || calls != 1 {
		t.Fatal("cross-origin preview accepted")
	}
}

func TestRTCSignallingBoundary(t *testing.T) {
	old := previewClient
	defer func() { previewClient = old }()
	calls := 0
	previewClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/rtc" {
			t.Fatal("wrong signalling route")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})}
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	for _, tc := range []struct {
		name, origin, body string
		auth               bool
		want               int
	}{
		{"unpaired", "https://phone.example", `{}`, false, 401},
		{"foreign origin", "https://evil.example", `{}`, true, 403},
		{"missing origin", "", `{}`, true, 403},
		{"oversize", "https://phone.example", strings.Repeat("x", 65537), true, 413},
		{"paired", "https://phone.example", `{"op":"start"}`, true, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := localRequest("POST", "https://phone.example/api/preview/rtc")
			r.Body = io.NopCloser(strings.NewReader(tc.body))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			if tc.auth {
				r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "secret"})
			}
			w := httptest.NewRecorder()
			s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
		})
	}
	if calls != 1 {
		t.Fatalf("unauthorized requests reached capture: %d", calls)
	}
}
