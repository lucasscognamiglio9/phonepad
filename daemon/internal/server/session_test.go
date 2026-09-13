package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOneUsePairing(t *testing.T) {
	s := New(staticAuth("durable-secret"), &fakeInjector{}, nil, "https://phone.example/?token=durable-secret")
	link, err := s.issuePairURL()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(link, "durable-secret") {
		t.Fatal("credential in QR")
	}
	u, _ := url.Parse(link)
	code := strings.TrimPrefix(u.Fragment, "pair=")
	claim := func(origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://phone.example/api/claim", strings.NewReader(`{"code":"`+code+`"}`))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
		return w
	}
	if w := claim("https://evil.example"); w.Code != 403 {
		t.Fatalf("cross origin %d", w.Code)
	}
	w := claim("https://phone.example")
	if w.Code != 204 {
		t.Fatalf("claim %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing cookie")
	}
	c := cookies[0]
	if c.Name != sessionCookieName || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" || c.MaxAge <= 0 {
		t.Fatalf("unsafe cookie %+v", c)
	}
	if w.Body.Len() != 0 {
		t.Fatal("response body")
	}
	r := localRequest("GET", "/api/auth")
	r.AddCookie(c)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal("cookie auth failed")
	}
	if w = claim("https://phone.example"); w.Code != 401 {
		t.Fatal("replay accepted")
	}
	s.issuePairURL()
	s.pairExpires = time.Now().Add(-time.Second)
	code = s.pairCode
	if w = claim("https://phone.example"); w.Code != 401 {
		t.Fatal("expired code accepted")
	}
}
func TestGatewayIsolation(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, nil, "https://phone.example/")
	h := s.RemoteHandler("https://phone.example")
	for _, path := range []string{"/pair", "/pair.html", "/qr.svg", "/api/pair-info", "/events", "/share", "/share.html", "/api/desktop?role=publisher"} {
		r := httptest.NewRequest("GET", "https://phone.example"+path, nil)
		r.RemoteAddr = "127.0.0.1:12"
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "secret"})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Errorf("exposed %s: %d", path, w.Code)
		}
	}
	for _, remote := range []string{"192.168.1.2:12", "100.64.0.1:12"} {
		r := httptest.NewRequest("GET", "https://phone.example/api/auth", nil)
		r.RemoteAddr = remote
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("nonproxy accepted")
		}
	}
	r := localRequest("GET", "https://wrong.example/api/auth")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("wrong host accepted")
	}
	for _, path := range []string{"/ws?token=secret", "/api/desktop?role=viewer&token=secret"} {
		r := localRequest("GET", path)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("URL credential accepted %s %d", path, w.Code)
		}
	}
}
