package server

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// Canal de eventos daemon → vista pairing (SPEC §12). La vista solo recibe, así
// que usamos SSE: unidireccional, reconecta solo y es trivial en Go. Puede haber
// N observadores aunque el cliente de control siga siendo 1.

// clientInfo es la metadata del cliente PWA que se muestra en la vista.
type clientInfo struct {
	UA    string `json:"ua"`
	Since string `json:"since"` // RFC3339
}

// sseEvent es un evento SSE con nombre y payload JSON ya serializado.
type sseEvent struct {
	name string // "state" | "client_connected" | "client_disconnected"
	data []byte // JSON
}

// statePayload es el cuerpo de los eventos state/client_* (SPEC §12).
type statePayload struct {
	Connected bool        `json:"connected"`
	Client    *clientInfo `json:"client"`
}

// hub mantiene el set de suscriptores SSE y el estado de conexión actual.
// El estado se usa para el snapshot inicial que recibe cada suscriptor nuevo.
type hub struct {
	mu        sync.Mutex
	subs      map[chan sseEvent]struct{}
	connected bool
	client    *clientInfo
}

func newHub() *hub {
	return &hub{subs: make(map[chan sseEvent]struct{})}
}

// subscribe registra un canal nuevo y devuelve el snapshot del estado actual
// (para que una vista que abre después de la conexión vea el estado correcto).
func (h *hub) subscribe() (ch chan sseEvent, snapshot sseEvent, cancel func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch = make(chan sseEvent, 8)
	h.subs[ch] = struct{}{}
	snapshot = sseEvent{name: "state", data: mustJSON(statePayload{Connected: h.connected, Client: h.client})}
	cancel = func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
	return ch, snapshot, cancel
}

// clientConnected actualiza el estado y emite client_connected. En un reemplazo
// (ya había cliente) sigue siendo un único client_connected con el cliente nuevo.
func (h *hub) clientConnected(ua string) {
	ci := &clientInfo{UA: ua, Since: time.Now().UTC().Format(time.RFC3339)}
	h.mu.Lock()
	h.connected = true
	h.client = ci
	h.mu.Unlock()
	h.publish(sseEvent{name: "client_connected", data: mustJSON(statePayload{Connected: true, Client: ci})})
}

// clientDisconnected actualiza el estado y emite client_disconnected.
func (h *hub) clientDisconnected() {
	h.mu.Lock()
	h.connected = false
	h.client = nil
	h.mu.Unlock()
	h.publish(sseEvent{name: "client_disconnected", data: mustJSON(statePayload{Connected: false, Client: nil})})
}

// publish manda el evento a todos los suscriptores sin bloquear: si un canal
// está lleno (suscriptor lento), se descarta el evento para ese suscriptor.
func (h *hub) publish(ev sseEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Los payloads son structs conocidos (bool + string), así que esto no
		// debería pasar nunca; si pasa, logueamos en vez de callar el fallo.
		log.Printf("mustJSON: %v", err)
		return []byte("{}")
	}
	return b
}
