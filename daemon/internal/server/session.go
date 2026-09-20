package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const sessionCookieName = "__Host-phonepad"
const pairingLifetime = 2 * time.Minute

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
func setSession(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 365 * 24 * 60 * 60})
}
func sameOrigin(r *http.Request) bool {
	u, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || u.Host != r.Host || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	ip := net.ParseIP(host)
	return u.Scheme == "http" && (host == "localhost" || (ip != nil && ip.IsLoopback()))
}

// Only a short-lived invitation enters the QR, in a fragment (not HTTP URLs).
func (s *Server) issuePairURL() (string, error) {
	s.pairMu.Lock()
	defer s.pairMu.Unlock()
	if s.pairCode == "" || time.Now().After(s.pairExpires) {
		b := make([]byte, 24)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		s.pairCode = base64.RawURLEncoding.EncodeToString(b)
		s.pairExpires = time.Now().Add(pairingLifetime)
	}
	u, err := url.Parse(safePairURL(s.pairURL))
	if err != nil {
		return "", err
	}
	u.Fragment = "pair=" + s.pairCode
	return u.String(), nil
}

func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method", 405)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "json required", 415)
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 512)).Decode(&body) != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	issuer, ok := s.auth.(interface{ Token() string })
	if !ok {
		http.Error(w, "pairing unavailable", 503)
		return
	}
	s.pairMu.Lock()
	valid := len(body.Code) == 32 && s.pairCode != "" && time.Now().Before(s.pairExpires) && subtle.ConstantTimeCompare([]byte(body.Code), []byte(s.pairCode)) == 1
	if valid {
		s.pairCode = ""
		s.pairExpires = time.Time{}
	}
	s.pairMu.Unlock()
	if !valid {
		http.Error(w, "QR usado o vencido; abrir uno nuevo en la laptop", 401)
		return
	}
	setSession(w, issuer.Token())
	w.WriteHeader(http.StatusNoContent)
}

// RemoteHandler deliberately excludes operator routes even behind a loopback
// reverse proxy. The proxy must preserve the configured public Host.
func (s *Server) RemoteHandler(publicOrigin string) http.Handler {
	u, err := url.Parse(publicOrigin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		panic("invalid HTTPS public origin")
	}
	publicHost := u.Host
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() || r.Host != publicHost {
			http.Error(w, "gateway only", 403)
			return
		}
		p := r.URL.Path
		allowed := p == "/" || p == "/index.html" || p == "/app.js" || p == "/preview.js" || p == "/rtc.js" || p == "/desktop.js" || p == "/style.css" || p == "/sw.js" || p == "/manifest.webmanifest" || p == "/icon-180.png" || p == "/icon-192.png" || p == "/icon-512.png" || (strings.HasPrefix(p, "/fonts/") && strings.HasSuffix(p, ".woff2")) || (p == "/api/preview/status" || p == "/api/preview/video" || p == "/api/preview/rtc") || p == "/api/files" || p == "/api/file-batches" || p == "/api/file-transfers" || p == "/api/input" || p == nativeUpdateRoute || p == "/api/auth" || p == "/api/claim" || p == "/api/mode" || p == "/ws" || (p == "/api/desktop" && r.URL.Query().Get("role") == "viewer")
		if !allowed {
			http.Error(w, "operator route unavailable", 403)
			return
		}
		control := (p == "/api/preview/status" || p == "/api/preview/video" || p == "/api/preview/rtc") || p == "/api/files" || p == "/api/file-batches" || p == "/api/file-transfers" || p == "/api/input" || p == nativeUpdateRoute || p == "/api/auth" || p == "/api/claim" || p == "/ws" || p == "/api/desktop"
		if control && s.trustedPeer != nil {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || (r.Header.Get("Origin") != "" && !sameOrigin(r)) {
				http.Error(w, "origin", 403)
				return
			}
			if s.trustedPeer(r) {
				r = r.WithContext(context.WithValue(r.Context(), trustedNodeKey{}, true))
				if p == "/api/claim" {
					w.WriteHeader(204)
					return
				}
			}
		}
		s.mux.ServeHTTP(w, r)
	})
}
