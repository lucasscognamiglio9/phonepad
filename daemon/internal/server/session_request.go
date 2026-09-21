package server

import (
	"context"
	"net/http"
)

func (s *Server) acceptRequestSession(w http.ResponseWriter, r *http.Request) bool {
	epoch := r.Header.Get("X-PhonePad-Session")
	if epoch == "" {
		return true
	}
	s.mu.Lock()
	valid := s.currentProtocol == protocolVersion && s.sessionEpoch != "" && epoch == s.sessionEpoch
	s.mu.Unlock()
	if !valid {
		http.Error(w, "stale control session", http.StatusConflict)
	}
	return valid
}

// Bind authorization and the client's epoch to the SAME captured permit.
// runPermittedMutation rechecks that permit immediately before the effect.
func (s *Server) captureRequestMutationPermit(r *http.Request, scope string) (mutationPermit, bool) {
	permit, ok := s.captureMutationPermit(scope)
	if epoch := r.Header.Get("X-PhonePad-Session"); epoch != "" && epoch != permit.sessionEpoch {
		return mutationPermit{}, false
	}
	return permit, ok
}

// Media has its own session lifetime, independent of input permission revocation.
func (s *Server) requestSessionContext(r *http.Request) (context.Context, func(), bool) {
	epoch := r.Header.Get("X-PhonePad-Session")
	if epoch == "" {
		return r.Context(), func() {}, true
	}
	s.mu.Lock()
	valid := s.currentProtocol == protocolVersion && epoch == s.sessionEpoch
	session := s.controlCtx
	s.mu.Unlock()
	if !valid {
		return nil, func() {}, false
	}
	ctx, cancel := context.WithCancel(r.Context())
	if session == nil {
		return ctx, cancel, true
	}
	stop := context.AfterFunc(session, cancel)
	return ctx, func() { stop(); cancel() }, true
}
