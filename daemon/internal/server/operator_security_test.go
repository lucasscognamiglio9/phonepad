package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestOperatorRoutesRejectReboundHost(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{
		"pair.html":  {Data: []byte("pair")},
		"share.html": {Data: []byte("share")},
	}, "https://phone.example")
	for _, path := range []string{"/pair", "/pair.html", "/qr.svg", "/api/pair-info", "/events", "/share", "/share.html", "/api/desktop?role=publisher"} {
		r := httptest.NewRequest(http.MethodGet, "http://rebound.example:8082"+path, nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", "http://rebound.example:8082")
		ctx, cancel := context.WithCancel(r.Context())
		cancel()
		r = r.WithContext(ctx)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s accepted a rebound Host: %d", path, w.Code)
		}
	}
}

func TestOperatorRoutesRejectCrossSiteRequests(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	for _, path := range []string{"/qr.svg", "/api/pair-info"} {
		for _, header := range []string{"Origin", "Sec-Fetch-Site"} {
			r := httptest.NewRequest(http.MethodGet, "http://localhost:8082"+path, nil)
			r.RemoteAddr = "127.0.0.1:1234"
			if header == "Origin" {
				r.Header.Set(header, "https://external.example")
			} else {
				r.Header.Set(header, "cross-site")
			}
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != http.StatusForbidden {
				t.Errorf("%s accepted %s: %d", path, header, w.Code)
			}
		}
	}
}

func TestOperatorRoutesAllowLoopbackOrigins(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example")
	for _, host := range []string{"localhost:8082", "127.0.0.1:8082", "[::1]:8082"} {
		r := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/pair-info", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", "http://"+host)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"paired":false`) {
			t.Errorf("loopback %s: %d", host, w.Code)
		}
	}
}

func TestSecurityHeadersOnLocalAndGatewayResponses(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{
		"index.html": {Data: []byte("index")},
	}, "https://phone.example")
	for _, handler := range []http.Handler{s.Handler(), s.RemoteHandler("https://phone.example")} {
		r := httptest.NewRequest(http.MethodGet, "https://phone.example/", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK || w.Header().Get("X-Content-Type-Options") != "nosniff" ||
			w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("Referrer-Policy") != "no-referrer" ||
			!strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("missing browser protections: %d %v", w.Code, w.Header())
		}
	}
}
