package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

type trustedNodeKey struct{}

func trustedNode(r *http.Request) bool { v, _ := r.Context().Value(trustedNodeKey{}).(bool); return v }

// Serve overwrites the source header. Trust it only on the dedicated loopback
// gateway, then resolve it through tailscaled and match the pinned stable node.
// No browser receives a bearer credential from this authorization path.
func WithTrustedTailscaleNode(id string) Option {
	return func(s *Server) {
		if id == "" {
			return
		}
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/tailscale/tailscaled.sock")
		}}}
		s.trustedPeer = tailVerifier(client, id)
	}
}
func tailVerifier(client *http.Client, id string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		addr := r.Header.Get("X-Forwarded-For")
		if id == "" || net.ParseIP(addr) == nil || r.Header.Get("Tailscale-Funnel-Request") != "" || r.Header.Get("Tailscale-User-Login") == "" {
			return false
		}
		req, err := http.NewRequestWithContext(r.Context(), "GET", "http://local-tailscaled.sock/localapi/v0/whois?addr="+url.QueryEscape(addr), nil)
		if err != nil {
			return false
		}
		res, err := client.Do(req)
		if err != nil {
			return false
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return false
		}
		var peer struct {
			Node struct {
				StableID  string
				KeyExpiry time.Time
				Expired   bool
			}
			UserProfile struct{ LoginName string }
		}
		if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&peer) != nil {
			return false
		}
		return peer.Node.StableID == id && peer.UserProfile.LoginName == r.Header.Get("Tailscale-User-Login") && !peer.Node.Expired && !peer.Node.KeyExpiry.IsZero() && time.Now().Before(peer.Node.KeyExpiry)
	}
}
