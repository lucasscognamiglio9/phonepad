package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"phonepad/daemon/internal/input"
	"phonepad/daemon/internal/inputops"
)

type inputLease struct {
	registry *inputops.Registry
	created  time.Time
	retired  time.Time
	targets  map[string]string
}
type inputRequest struct {
	Op           string            `json:"op"`
	Session      string            `json:"session"`
	SessionEpoch string            `json:"sessionEpoch,omitempty"`
	OperationID  string            `json:"operationId"`
	Manifest     inputops.Manifest `json:"manifest"`
	Index        int               `json:"index"`
	Data         []byte            `json:"data"` // JSON base64; never decoded as lossy Unicode chunks.
}

// Called only under the same mutex that replaces the control websocket.
func (s *Server) newInputLease() {
	if old, ok := s.inputLeases[s.inputSession]; ok {
		old.registry.Retire()
		old.retired = time.Now()
		s.inputLeases[s.inputSession] = old
	}
	if s.inputLeases == nil {
		s.inputLeases = make(map[string]inputLease)
	}
	for id, lease := range s.inputLeases {
		if !lease.retired.IsZero() && time.Since(lease.retired) > 10*time.Minute {
			delete(s.inputLeases, id)
		}
	}
	if len(s.inputLeases) >= 4 {
		var oldest string
		var stamp time.Time
		for id, lease := range s.inputLeases {
			if oldest == "" || lease.created.Before(stamp) {
				oldest = id
				stamp = lease.created
			}
		}
		delete(s.inputLeases, oldest)
	}
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		s.inputSession = ""
		return
	}
	s.inputSession = hex.EncodeToString(nonce[:])
	registry, _ := inputops.NewRegistry(s.inputSession)
	s.inputLeases[s.inputSession] = inputLease{registry: registry, created: time.Now(), targets: make(map[string]string)}
}

func (s *Server) inputHello(gen uint64) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen != gen {
		return nil
	}
	if s.currentProtocol == protocolVersion {
		// The first frame keeps the long-standing handshake type. Subsequent
		// permission/capability changes use t=capabilities.
		payload := s.capabilitiesPayloadLocked()
		payload["t"] = "ok"
		data, _ := json.Marshal(payload)
		return data
	}
	return s.legacyHelloLocked()
}

func (s *Server) handleInput(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		http.Error(w, "JSON required", 415)
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Second))
	var request inputRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		http.Error(w, "invalid operation", 400)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		http.Error(w, "invalid operation", 400)
		return
	}
	if !validSessionEpoch(request.SessionEpoch) {
		http.Error(w, "invalid session epoch", 400)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.currentProtocol == protocolVersion && (s.sessionEpoch == "" || request.SessionEpoch == "" || request.SessionEpoch != s.sessionEpoch) {
		http.Error(w, "stale session epoch", 409)
		return
	}
	if request.Op != "status" && request.Op != "cancel" {
		permission, allowed := s.permissionLocked(mutationScopeInput)
		if !allowed {
			http.Error(w, permissionRejectionCode(permission, "input_unavailable"), http.StatusForbidden)
			return
		}
	}
	lease, ok := s.inputLeases[request.Session]
	if !ok || (s.inputSession != request.Session && !lease.retired.IsZero() && time.Since(lease.retired) > 10*time.Minute) {
		http.Error(w, "unknown input session; do not replay", 409)
		return
	}
	respond := func(value any) { w.Header().Set("Content-Type", "application/json"); json.NewEncoder(w).Encode(value) }
	if request.Op == "status" {
		receipt, found := lease.registry.Lookup(request.OperationID)
		if !found {
			http.Error(w, "unknown operation; do not replay", 404)
			return
		}
		respond(receipt)
		return
	}
	if request.Op == "cancel" {
		receipt, found := lease.registry.Lookup(request.OperationID)
		if !found {
			http.Error(w, "unknown operation; do not replay", 404)
			return
		}
		transfer, err := lease.registry.Begin(receipt.Manifest)
		if err != nil {
			http.Error(w, "operation unavailable", 409)
			return
		}
		receipt, err = transfer.Cancel()
		// Retire turns receiving/ready operations into cancelled tombstones.
		// A later explicit cancel must remain an idempotent recovery action.
		if errors.Is(err, inputops.ErrState) && receipt.State == inputops.Cancelled {
			err = nil
		}
		if err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		respond(receipt)
		return
	}
	if s.current == nil || s.inputSession != request.Session {
		http.Error(w, "inactive input session", 409)
		return
	}
	if request.Op == "renew" {
		s.newInputLease()
		response := map[string]any{"session": s.inputSession, "version": 1}
		if s.currentProtocol == protocolVersion {
			response["sessionEpoch"] = s.sessionEpoch
		}
		respond(response)
		return
	}
	var transfer *inputops.TextTransfer
	if request.Op == "begin" {
		if request.Manifest.Session != request.Session {
			http.Error(w, "session mismatch", 400)
			return
		}
		var err error
		transfer, err = lease.registry.Begin(request.Manifest)
		if err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		if _, bound := lease.targets[request.Manifest.OperationID]; !bound && transfer.Receipt().State == inputops.Receiving {
			adapter, available := s.inj.(input.LiteralInjector)
			if !available {
				transfer.Cancel()
				http.Error(w, "literal adapter unavailable", 503)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			focus := adapter.LiteralFocus(ctx)
			cancel()
			if focus.State != "ready" || len(focus.Target) != 64 {
				transfer.Cancel()
				respond(map[string]any{"receipt": transfer.Receipt(), "detail": focus.Detail})
				return
			}
			lease.targets[request.Manifest.OperationID] = focus.Target
		}
		respond(transfer.Receipt())
		return
	}
	// Lookup the already validated immutable manifest; Begin only returns the
	// original transfer, never creates another operation for a retry.
	receipt, found := lease.registry.Lookup(request.OperationID)
	if !found {
		http.Error(w, "unknown operation; do not replay", 404)
		return
	}
	transfer, err := lease.registry.Begin(receipt.Manifest)
	if err != nil {
		http.Error(w, "operation unavailable", 409)
		return
	}
	switch request.Op {
	case "chunk":
		receipt, err = transfer.Append(request.Index, request.Data)
	case "commit":
		receipt, err = transfer.Commit()
		if err == nil && receipt.State == inputops.Ready {
			adapter, available := s.inj.(input.LiteralInjector)
			if !available {
				http.Error(w, "literal adapter unavailable", 503)
				return
			}
			text, claimErr := transfer.Claim()
			if claimErr != nil {
				http.Error(w, "operation already dispatched", 409)
				return
			}
			// Serialize with all other control input. No HTTP cancellation can turn
			// an uncertain operation into a retryable one. Adapter timeout is bounded.
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			result := adapter.LiteralText(ctx, text, lease.targets[request.OperationID])
			cancel()
			state := inputops.Uncertain
			if result.State == "dispatched" {
				state = inputops.Dispatched
			}
			if result.State == "rejected" {
				state = inputops.Rejected
			}
			receipt, err = transfer.Finish(state)
			if err == nil {
				respond(map[string]any{"receipt": receipt, "detail": result.Detail})
				return
			}
		}
	default:
		http.Error(w, "unsupported operation", 400)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	respond(receipt)
}
