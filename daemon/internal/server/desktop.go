package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// A LAN-only rendezvous. Video flows peer-to-peer, never through Go or a cloud.
// The publisher is an explicitly opened local browser; viewers need pairing.
type desktopRelay struct {
	mu                sync.Mutex
	publisher, viewer *websocket.Conn
	browser           *browserPreviewSession
}

func writeSignal(c *websocket.Conn, data []byte) {
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if c.Write(ctx, websocket.MessageText, data) != nil {
		c.CloseNow()
	}
}

func (s *Server) handleShare(webFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !localOnly(w, r) {
			return
		}
		data, err := fs.ReadFile(webFS, "share.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(data)
	}
}

func (s *Server) handleDesktop(w http.ResponseWriter, r *http.Request) {
	if s.rejectIfClosing(w) {
		return
	}
	publisher := r.URL.Query().Get("role") == "publisher"
	if publisher {
		if !localOnly(w, r) {
			return
		}
		// Browsers must originate from this local page, never an unrelated website.
		if !sameOrigin(r) {
			http.Error(w, "origin required", 403)
			return
		}
	} else if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(64 * 1024)
	if s.isClosing() {
		c.CloseNow()
		return
	}
	relay := &s.desktop
	relay.mu.Lock()
	var old, peer *websocket.Conn
	if publisher {
		old = relay.publisher
		relay.publisher = c
		peer = relay.viewer
	} else {
		old = relay.viewer
		relay.viewer = c
		peer = relay.publisher
	}
	relay.mu.Unlock()
	if old != nil {
		old.CloseNow()
	}
	if peer != nil {
		writeSignal(peer, []byte(`{"type":"ready"}`))
	}
	defer func() {
		relay.mu.Lock()
		var other *websocket.Conn
		if publisher && relay.publisher == c {
			relay.publisher = nil
			other = relay.viewer
			relay.browser = nil
		}
		if !publisher && relay.viewer == c {
			relay.viewer = nil
			other = relay.publisher
		}
		relay.mu.Unlock()
		c.CloseNow()
		writeSignal(other, []byte(`{"type":"stop"}`))
	}()
	ctx, cancel := s.contextWithLifecycle(context.Background())
	defer cancel()
	go s.watchdog(ctx, c, wsHeartbeatInterval, wsHeartbeatTimeout)
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg.Type != "candidate" && msg.Type != "stop" && !(publisher && msg.Type == "offer") && !(!publisher && (msg.Type == "answer" || msg.Type == "ready")) {
			continue
		}
		relay.mu.Lock()
		var target *websocket.Conn
		var browser *browserPreviewSession
		if publisher && relay.publisher == c {
			if relay.browser == nil {
				target = relay.viewer
			}
			browser = relay.browser
		}
		if !publisher && relay.viewer == c {
			target = relay.publisher
		}
		relay.mu.Unlock()
		if publisher && msg.Type == "offer" && browser != nil {
			select {
			case browser.offers <- data:
			default:
			}
		}
		writeSignal(target, data)
	}
}
