package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClipboardTextSessionAndUnicode(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.sessionEpoch = "current"
	s.currentProtocol = protocolVersion
	read := 0
	s.readClipboardText = func(context.Context) (string, error) { read++; return "¿_😀\ntexto", nil }
	for _, epoch := range []string{"", "stale", "current"} {
		r := httptest.NewRequest("GET", "https://phonepad/api/clipboard", nil)
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "tok"})
		r.Header.Set("Origin", "https://phonepad")
		r.Header.Set("X-PhonePad-Session", epoch)
		w := httptest.NewRecorder()
		s.handleClipboardText(w, r)
		if epoch == "current" {
			if w.Code != 200 || !strings.Contains(w.Body.String(), "¿_😀") {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		} else if w.Code != 409 {
			t.Fatalf("stale request: %d", w.Code)
		}
	}
	if read != 1 {
		t.Fatalf("read %d times", read)
	}
	s.clipboard = &recordingClipboard{}
	for _, body := range []string{`{"text":"¿_😀"}`, `{"text":"` + strings.Repeat("x", maxClipboardText+1) + `"}`} {
		r := httptest.NewRequest("POST", "https://phonepad/api/clipboard", strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "tok"})
		r.Header.Set("Origin", "https://phonepad")
		r.Header.Set("X-PhonePad-Session", "current")
		w := httptest.NewRecorder()
		s.handleClipboardText(w, r)
		if len(body) > maxClipboardText {
			if w.Code != 400 {
				t.Fatal(w.Code)
			}
		} else if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
}
func TestDirectPointerRange(t *testing.T) {
	for _, body := range []string{`{"t":"p","dx":-1,"dy":0}`, `{"t":"p","dx":65536,"dy":0}`} {
		if _, ok := Parse([]byte(body)); ok {
			t.Fatal("out of range accepted")
		}
	}
	if _, ok := Parse([]byte(`{"t":"p","dx":65535,"dy":0}`)); !ok {
		t.Fatal("valid coordinate rejected")
	}
}

type directCapabilityProbe struct{ capabilityProbe }

func (*directCapabilityProbe) SupportsDirectPointer() bool { return true }
func (*directCapabilityProbe) MoveNormalized(int, int)     {}
func TestDirectPointerRequiresClientOptIn(t *testing.T) {
	for _, query := range []string{"protocol=2", "protocol=2&directPointer=1"} {
		s := New(staticAuth("tok"), &directCapabilityProbe{}, nil, "")
		_, message, cleanup := dialCapabilities(t, s, query)
		actions := message["capabilities"].(map[string]any)["input"].(map[string]any)["actions"].([]any)
		found := false
		for _, action := range actions {
			if action == "p" {
				found = true
			}
		}
		cleanup()
		if found != strings.Contains(query, "directPointer=1") {
			t.Fatalf("%s: direct action = %v", query, found)
		}
	}
}
