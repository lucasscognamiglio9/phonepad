package server

import "net/http"

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
