package server

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"phonepad/daemon/internal/input"
	"sync/atomic"
	"testing"
)

type predictionProbe struct {
	capabilityProbe
	fences atomic.Int32
}

func (p *predictionProbe) PointerPrediction() (input.PointerPrediction, bool) {
	return input.PointerPrediction{PixelsPerMM: 20, Width: 1920, Height: 1080}, true
}
func (p *predictionProbe) PointerFence() (uint64, bool) {
	p.fences.Add(1)
	return uint64(p.moves.Load()) + 1000, true
}

func TestPointerFenceFollowsInputAndRequiresCurrentGrantedSession(t *testing.T) {
	p := &predictionProbe{}
	s := New(staticAuth("tok"), p, nil, "")
	c, hello, close := dialCapabilities(t, s, "protocol=2")
	defer close()
	caps := hello["capabilities"].(map[string]any)["input"].(map[string]any)
	if caps["pointerPrediction"].(map[string]any)["pixelsPerMm"] != float64(20) {
		t.Fatal(caps)
	}
	epoch := hello["sessionEpoch"].(string)
	send := func(m Msg) {
		t.Helper()
		data, _ := json.Marshal(m)
		if err := c.Write(context.Background(), websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	send(Msg{Type: "m", Dx: 2, SessionEpoch: epoch})
	send(Msg{Type: "ping", PointerFence: 1, SessionEpoch: epoch})
	response := readWSJSON(t, c)
	if response["available"] != true || response["appliedAtUs"] != float64(1001) || response["pointerFence"] != float64(1) {
		t.Fatal(response)
	}
	send(Msg{Type: "ping", PointerFence: 2, SessionEpoch: "old"})
	response = readWSJSON(t, c)
	if response["available"] != false || p.fences.Load() != 1 {
		t.Fatal("stale epoch admitted", response)
	}
	s.mu.Lock()
	permissions := s.effectivePermissionsLocked()
	s.mu.Unlock()
	permissions.Input = Permission{State: "revoked"}
	if err := s.SetPermissions(permissions); err != nil {
		t.Fatal(err)
	}
	update := readWSJSON(t, c)
	if update["t"] != "capabilities" {
		t.Fatal(update)
	}
	if _, present := update["capabilities"].(map[string]any)["input"].(map[string]any)["pointerPrediction"]; present {
		t.Fatal("prediction advertised after revocation")
	}
	send(Msg{Type: "ping", PointerFence: 3, SessionEpoch: epoch})
	response = readWSJSON(t, c)
	if response["available"] != false || p.fences.Load() != 1 {
		t.Fatal("revoked fence admitted", response)
	}
}
func TestPointerFenceIsAnAdditivePingOnlyField(t *testing.T) {
	for _, frame := range []string{`{"t":"ping","pointerFence":-1}`, `{"t":"ping","pointerFence":1073741825}`, `{"t":"m","dx":1,"pointerFence":1}`} {
		if _, ok := Parse([]byte(frame)); ok {
			t.Fatal("invalid fence parsed", frame)
		}
	}
}
