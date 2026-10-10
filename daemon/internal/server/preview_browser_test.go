package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

func TestBrowserPreviewBrokersNativeReceiver(t *testing.T) {
	s := New(staticAuth("secret"), &fakeInjector{}, fstest.MapFS{}, "", WithBrowserPreview())
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	publisher, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/desktop?role=publisher",
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {ts.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.CloseNow()
	request := func(method, path, body string) *http.Response {
		req, err := http.NewRequestWithContext(ctx, method, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "secret"})
		req.Header.Set("Origin", ts.URL)
		if method == "POST" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	status := request("GET", "/api/preview/status", "")
	var available struct{ State, Provider string }
	if err := json.NewDecoder(status.Body).Decode(&available); err != nil || available.State != "ready" || available.Provider != "browser" {
		t.Fatalf("browser status: %+v, %v", available, err)
	}
	status.Body.Close()
	started := make(chan *http.Response, 1)
	go func() { started <- request("POST", "/api/preview/rtc", `{"op":"start"}`) }()
	_, ready, err := publisher.Read(ctx)
	if err != nil || string(ready) != `{"type":"ready"}` {
		t.Fatalf("publisher ready: %s, %v", ready, err)
	}
	if err := publisher.Write(ctx, websocket.MessageText, []byte(`{"type":"offer","description":{"type":"offer","sdp":"test-offer"}}`)); err != nil {
		t.Fatal(err)
	}
	response := <-started
	defer response.Body.Close()
	var offer struct{ ID, SDP string }
	if err := json.NewDecoder(response.Body).Decode(&offer); err != nil || response.StatusCode != 200 || offer.ID == "" || offer.SDP != "test-offer" {
		t.Fatalf("native offer: %+v, %d, %v", offer, response.StatusCode, err)
	}
	answer, _ := json.Marshal(map[string]string{"op": "answer", "id": offer.ID, "sdp": "test-answer"})
	ack := request("POST", "/api/preview/rtc", string(answer))
	io.Copy(io.Discard, ack.Body)
	ack.Body.Close()
	if ack.StatusCode != 200 {
		t.Fatalf("answer status: %d", ack.StatusCode)
	}
	_, forwarded, err := publisher.Read(ctx)
	if err != nil || !strings.Contains(string(forwarded), `"sdp":"test-answer"`) {
		t.Fatalf("forwarded answer: %s, %v", forwarded, err)
	}
}
