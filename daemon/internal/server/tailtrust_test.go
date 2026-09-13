package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestTailIdentity(t *testing.T) {
	body := fmt.Sprintf(`{"Node":{"StableID":"phone","KeyExpiry":%q},"UserProfile":{"LoginName":"owner"}}`, time.Now().Add(time.Hour).Format(time.RFC3339))
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	verify := tailVerifier(client, "phone")
	req := httptest.NewRequest("GET", "https://phone.example/api/auth", nil)
	req.Header.Set("X-Forwarded-For", "100.118.23.97")
	req.Header.Set("Tailscale-User-Login", "owner")
	if !verify(req) {
		t.Fatal("valid node denied")
	}
	for _, bad := range []string{strings.Replace(body, "phone", "other", 1), strings.Replace(body, "owner", "other", 1), `{}`, `broken`, strings.Replace(body, time.Now().Add(time.Hour).Format(time.RFC3339), "2000-01-01T00:00:00Z", 1)} {
		saved := body
		body = bad
		if verify(req) {
			t.Fatalf("bad identity accepted %s", bad)
		}
		body = saved
	}
	req.Header.Set("X-Forwarded-For", "100.1.1.1, 100.118.23.97")
	if verify(req) {
		t.Fatal("source chain accepted")
	}
	req.Header.Set("X-Forwarded-For", "100.118.23.97")
	req.Header.Set("Tailscale-Funnel-Request", "?1")
	if verify(req) {
		t.Fatal("funnel accepted")
	}
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { return nil, fmt.Errorf("offline") })
	if verify(req) {
		t.Fatal("offline accepted")
	}
}
func TestTrustedGatewayBoundary(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	s.trustedPeer = func(r *http.Request) bool { return r.Header.Get("X-Forwarded-For") == "100.118.23.97" }
	for _, tc := range []struct {
		path, remote, origin, source string
		status                       int
	}{
		{"/api/auth", "127.0.0.1:1", "https://phone.example", "100.118.23.97", 204},
		{"/api/auth", "127.0.0.1:1", "https://evil.example", "100.118.23.97", 403},
		{"/api/auth", "192.168.1.1:1", "https://phone.example", "100.118.23.97", 403},
		{"/api/auth", "127.0.0.1:1", "https://phone.example", "100.1.2.3", 401},
		{"/qr.svg", "127.0.0.1:1", "https://phone.example", "100.118.23.97", 403},
		{"/api/desktop?role=publisher", "127.0.0.1:1", "https://phone.example", "100.118.23.97", 403},
	} {
		r := httptest.NewRequest("GET", "https://phone.example"+tc.path, nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Forwarded-For", tc.source)
		w := httptest.NewRecorder()
		s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%+v got %d", tc, w.Code)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("identity authorization leaked cookie")
		}
	}
	r := localRequest("GET", "/api/auth")
	r.Header.Set("X-Forwarded-For", "100.118.23.97")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("direct handler trusted header")
	}
}
