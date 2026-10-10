package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
)

// The browser already owns an OS-screen-share grant and a hardware-backed
// WebRTC encoder. This session brokers only signaling; video never enters Go.
type browserPreviewSession struct {
	id     string
	offers chan []byte
}

func browserResponse(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) handleBrowserPreview(w http.ResponseWriter, ctx context.Context, path, operation string, raw []byte) {
	if path == "/video" {
		http.Error(w, "browser preview uses WebRTC", http.StatusNotFound)
		return
	}
	relay := &s.desktop
	if path == "/status" {
		relay.mu.Lock()
		ready := relay.publisher != nil
		relay.mu.Unlock()
		state := "idle"
		if ready {
			state = "ready"
		}
		browserResponse(w, map[string]any{"state": state, "webrtc": true, "codec": "h264", "provider": "browser"})
		return
	}
	var request struct {
		ID  string `json:"id"`
		SDP string `json:"sdp"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &request) != nil {
		http.Error(w, "invalid signaling", http.StatusBadRequest)
		return
	}
	switch operation {
	case "start":
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			http.Error(w, "preview unavailable", http.StatusServiceUnavailable)
			return
		}
		session := &browserPreviewSession{id: hex.EncodeToString(nonce[:]), offers: make(chan []byte, 1)}
		relay.mu.Lock()
		publisher := relay.publisher
		viewer := relay.viewer
		if publisher != nil {
			relay.browser = session
			relay.viewer = nil
		}
		relay.mu.Unlock()
		if viewer != nil {
			viewer.CloseNow()
		}
		if publisher == nil {
			http.Error(w, "open screen sharing on this computer", http.StatusServiceUnavailable)
			return
		}
		writeSignal(publisher, []byte(`{"type":"ready"}`))
		var data []byte
		select {
		case data = <-session.offers:
		case <-ctx.Done():
			relay.mu.Lock()
			if relay.browser == session {
				relay.browser = nil
			}
			relay.mu.Unlock()
			http.Error(w, "screen sharing timed out", http.StatusGatewayTimeout)
			return
		}
		var offer struct {
			Description struct {
				Type string `json:"type"`
				SDP  string `json:"sdp"`
			} `json:"description"`
		}
		if json.Unmarshal(data, &offer) != nil || offer.Description.Type != "offer" || offer.Description.SDP == "" {
			http.Error(w, "invalid screen offer", http.StatusBadGateway)
			return
		}
		relay.mu.Lock()
		valid := relay.browser == session && relay.publisher == publisher
		relay.mu.Unlock()
		if !valid {
			http.Error(w, "screen sharing changed", http.StatusConflict)
			return
		}
		browserResponse(w, map[string]any{"id": session.id, "sdp": offer.Description.SDP})
	case "answer":
		if request.SDP == "" || request.ID == "" {
			http.Error(w, "invalid answer", http.StatusBadRequest)
			return
		}
		relay.mu.Lock()
		publisher := relay.publisher
		valid := relay.browser != nil && relay.browser.id == request.ID && publisher != nil
		relay.mu.Unlock()
		if !valid {
			http.Error(w, "stale screen session", http.StatusConflict)
			return
		}
		answer, _ := json.Marshal(map[string]any{"type": "answer", "description": map[string]string{"type": "answer", "sdp": request.SDP}})
		writeSignal(publisher, answer)
		browserResponse(w, map[string]any{"state": "live"})
	case "stop":
		relay.mu.Lock()
		publisher := relay.publisher
		if relay.browser != nil && relay.browser.id == request.ID {
			relay.browser = nil
		} else {
			publisher = nil
		}
		relay.mu.Unlock()
		if publisher != nil {
			writeSignal(publisher, []byte(`{"type":"stop"}`))
		}
		browserResponse(w, map[string]any{"state": "stopped"})
	case "feedback", "resume", "suspend", "diagnostic":
		relay.mu.Lock()
		valid := relay.publisher != nil && relay.browser != nil && relay.browser.id == request.ID
		relay.mu.Unlock()
		if !valid && operation != "diagnostic" {
			http.Error(w, "screen sharing unavailable", http.StatusServiceUnavailable)
			return
		}
		browserResponse(w, map[string]any{"state": "live"})
	default:
		http.Error(w, "invalid preview operation", http.StatusBadRequest)
	}
}
