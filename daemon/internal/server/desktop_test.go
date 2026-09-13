package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

func TestDesktopAccess(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{"share.html": {Data: []byte("share")}}, "")
	for _, tc := range []struct {
		path, remote, origin string
		status               int
	}{
		{"/share", "192.168.1.2:1234", "", 403},
		{"/share", "127.0.0.1:1234", "", 200},
		{"/api/desktop?role=publisher", "192.168.1.2:1234", "https://phonepad", 403},
		{"/api/desktop?role=publisher", "127.0.0.1:1234", "", 403},
		{"/api/desktop?token=wrong", "192.168.1.2:1234", "", 401},
	} {
		r := httptest.NewRequest("GET", tc.path, nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%s: %d, want %d", tc.path, w.Code, tc.status)
		}
	}
}

func TestDesktopRelayAndStop(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{}, "")
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dial := func(query string) *websocket.Conn {
		c, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/desktop?"+query, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {ts.URL}, "Cookie": {sessionCookieName + "=secret"}}})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	pub := dial("role=publisher")
	defer pub.CloseNow()
	viewer := dial("role=viewer")
	defer viewer.CloseNow()
	read := func(c *websocket.Conn, want string) {
		_, b, err := c.Read(ctx)
		if err != nil || string(b) != want {
			t.Fatalf("got %s %v; want %s", b, err, want)
		}
	}
	read(pub, `{"type":"ready"}`)
	offer := `{"type":"offer","description":{"type":"offer","sdp":"test"}}`
	if err := pub.Write(ctx, websocket.MessageText, []byte(offer)); err != nil {
		t.Fatal(err)
	}
	read(viewer, offer)
	answer := `{"type":"answer","description":{"type":"answer","sdp":"test"}}`
	if err := viewer.Write(ctx, websocket.MessageText, []byte(answer)); err != nil {
		t.Fatal(err)
	}
	read(pub, answer)
	viewer.CloseNow()
	read(pub, `{"type":"stop"}`)
}

func TestDesktopRejectsCrossOriginPublisher(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{}, "")
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, r, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/desktop?role=publisher", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://unrelated.example"}}})
	if c != nil {
		c.CloseNow()
	}
	if err == nil || r.StatusCode != 403 {
		t.Fatalf("cross origin accepted: %v", err)
	}
}
