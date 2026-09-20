package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/coder/websocket"

	"phonepad/daemon/internal/input"
	"phonepad/daemon/internal/inputops"
)

const (
	legacyProtocolVersion = 1
	protocolVersion       = 2
	maxSessionEpochBytes  = 128
)

var (
	errMutationPermission        = errors.New("mutation permission revoked")
	ErrViewPermissionUnsupported = errors.New("view permission revocation unsupported")
)

// Permission is the effective authorization state for one server-side scope.
// It is intentionally separate from capabilities: a granted clipboard
// permission can still have an unavailable desktop provider.
type Permission struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type Permissions struct {
	View      Permission `json:"view"`
	Input     Permission `json:"input"`
	Files     Permission `json:"files"`
	Clipboard Permission `json:"clipboard"`
}

type inputCapability struct {
	State     string   `json:"state"`
	Actions   []string `json:"actions"`
	Effective bool     `json:"effective"`
}

type literalCapability struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type videoCapability struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type capabilitySet struct {
	Input   inputCapability   `json:"input"`
	Literal literalCapability `json:"literal"`
	Video   videoCapability   `json:"video"`
}

type sourceCapability struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type geometryCapability struct {
	State         string  `json:"state"`
	GeometryEpoch *uint64 `json:"geometryEpoch"`
}

var inputActions = []string{"m", "b", "s", "k", "g", "t"}

type mutationPermit struct {
	scope        string
	revision     uint64
	sessionEpoch string
}

const (
	mutationScopeInput     = "input"
	mutationScopeFiles     = "files"
	mutationScopeClipboard = "clipboard"
)

func defaultPermissions(inj input.Injector) Permissions {
	inputPermission := Permission{State: "unavailable", Reason: "provider_unavailable"}
	if inj != nil {
		inputPermission = Permission{State: "granted"}
	}
	return Permissions{
		View:      Permission{State: "granted"},
		Input:     inputPermission,
		Files:     Permission{State: "granted"},
		Clipboard: Permission{State: "granted"},
	}
}

func normalizePermission(value Permission, fallback string) Permission {
	switch value.State {
	case "granted", "revoked", "unavailable":
		return value
	default:
		return Permission{State: fallback, Reason: "invalid_permission_state"}
	}
}

func normalizePermissions(value Permissions) Permissions {
	value.View = normalizePermission(value.View, "unavailable")
	value.Input = normalizePermission(value.Input, "unavailable")
	value.Files = normalizePermission(value.Files, "unavailable")
	value.Clipboard = normalizePermission(value.Clipboard, "unavailable")
	return value
}

func newSessionEpoch() (string, error) {
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(nonce[:]), nil
}

func validSessionEpoch(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > maxSessionEpochBytes {
		return false
	}
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}

func (s *Server) effectivePermissionsLocked() Permissions {
	permissions := s.permissions
	if permissions.Input.State == "granted" && s.inj == nil {
		permissions.Input = Permission{State: "unavailable", Reason: "provider_unavailable"}
	}
	return permissions
}

func (s *Server) permissionLocked(scope string) (Permission, bool) {
	permissions := s.effectivePermissionsLocked()
	var permission Permission
	switch scope {
	case mutationScopeInput:
		permission = permissions.Input
	case mutationScopeFiles:
		permission = permissions.Files
	case mutationScopeClipboard:
		permission = permissions.Clipboard
	default:
		return Permission{State: "unsupported", Reason: "unknown_scope"}, false
	}
	return permission, permission.State == "granted"
}

func (s *Server) inputAllowedLocked() bool {
	_, allowed := s.permissionLocked(mutationScopeInput)
	return allowed
}

func (s *Server) literalInputLocked() (map[string]any, bool) {
	if !s.inputAllowedLocked() || s.inputSession == "" {
		return nil, false
	}
	if _, ok := s.inj.(input.LiteralInjector); !ok {
		return nil, false
	}
	return map[string]any{
		"version":       1,
		"session":       s.inputSession,
		"maxTextBytes":  inputops.MaxTextBytes,
		"maxChunkBytes": inputops.MaxChunkBytes,
		"maxChunks":     inputops.MaxChunks,
		"textMode":      "literal-block",
		"maxOperations": inputops.MaxOperations,
	}, true
}

func (s *Server) capabilitiesPayloadLocked() map[string]any {
	permissions := s.effectivePermissionsLocked()
	inputState := "unavailable"
	inputActionsValue := []string{}
	effective := false
	if s.inputAllowedLocked() {
		inputState = "available"
		inputActionsValue = append(inputActionsValue, inputActions...)
		effective = !s.demo
	}

	literal := literalCapability{State: "unsupported", Reason: "no_literal_adapter"}
	if !s.inputAllowedLocked() {
		reason := permissions.Input.Reason
		if reason == "" {
			if permissions.Input.State == "revoked" {
				reason = "permission_revoked"
			} else {
				reason = "input_unavailable"
			}
		}
		literal = literalCapability{State: "unavailable", Reason: reason}
	} else if _, ok := s.inj.(input.LiteralInjector); ok && s.inputSession != "" {
		literal = literalCapability{State: "available"}
	}

	roles := []string{"viewer"}
	if s.inputAllowedLocked() {
		roles = append(roles, "controller")
	}
	payload := map[string]any{
		"t":                  "capabilities",
		"protocolVersion":    protocolVersion,
		"compatibleVersions": []int{legacyProtocolVersion, protocolVersion},
		"capabilityRevision": s.capabilityRevision,
		"roles":              roles,
		"permissions":        permissions,
		"capabilities": capabilitySet{
			Input:   inputCapability{State: inputState, Actions: inputActionsValue, Effective: effective},
			Literal: literal,
			Video:   videoCapability{State: "unknown", Reason: "query_preview_status"},
		},
		"sessionEpoch": s.sessionEpoch,
		"source":       sourceCapability{State: "unavailable", Reason: "preview_source_not_exposed"},
		"geometry":     geometryCapability{State: "unavailable", GeometryEpoch: nil},
	}
	if literalInput, ok := s.literalInputLocked(); ok {
		// Keep the P01A object at the top level so old clients can continue to
		// parse literal text limits without knowing the P02 envelope.
		payload["input"] = literalInput
	}
	return payload
}

func (s *Server) legacyHelloLocked() []byte {
	if literalInput, ok := s.literalInputLocked(); ok {
		response, _ := json.Marshal(map[string]any{"t": "ok", "input": literalInput})
		return response
	}
	return respOK
}

func (s *Server) capabilitiesMessageLocked() ([]byte, uint64) {
	data, _ := json.Marshal(s.capabilitiesPayloadLocked())
	return data, s.capabilityRevision
}

func rejectedMessage(scope, code string, revision uint64, sessionEpoch string) []byte {
	payload := map[string]any{
		"t":                  "rejected",
		"scope":              scope,
		"code":               code,
		"fatal":              false,
		"capabilityRevision": revision,
	}
	if sessionEpoch != "" {
		payload["sessionEpoch"] = sessionEpoch
	}
	data, _ := json.Marshal(payload)
	return data
}

func (s *Server) sendCapabilityUpdate(c *websocket.Conn, data []byte, revision uint64) {
	if c == nil || len(data) == 0 {
		return
	}
	s.capabilitySendMu.Lock()
	defer s.capabilitySendMu.Unlock()
	if revision <= s.capabilitySentRevision {
		return
	}
	s.mu.Lock()
	active := s.current == c && s.currentProtocol == protocolVersion
	s.mu.Unlock()
	if !active {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err := c.Write(ctx, websocket.MessageText, data)
	cancel()
	if err != nil {
		c.CloseNow()
		return
	}
	s.capabilitySentRevision = revision
}

// SetPermissions changes the host policy. View capture cannot be stopped by
// this server yet, so a request that would revoke or hide it is rejected before
// changing any state. Callers can still revoke input, files, or clipboard.
func (s *Server) SetPermissions(value Permissions) error {
	if value.View.State != "granted" {
		return ErrViewPermissionUnsupported
	}
	value = normalizePermissions(value)
	s.mutationGate.Lock()
	s.mu.Lock()
	wasInputAllowed := s.inputAllowedLocked()
	s.permissions = value
	nowInputAllowed := s.inputAllowedLocked()
	s.capabilityRevision++
	if wasInputAllowed && !nowInputAllowed {
		s.retireInputLeasesLocked()
		if s.current != nil {
			s.newInputLease()
		}
		resetInjector(s.inj)
	}
	var c *websocket.Conn
	if s.currentProtocol == protocolVersion {
		c = s.current
	}
	data, revision := s.capabilitiesMessageLocked()
	s.mu.Unlock()
	s.mutationGate.Unlock()
	s.sendCapabilityUpdate(c, data, revision)
	return nil
}

func (s *Server) retireInputLeasesLocked() {
	if s.inputLeases == nil {
		return
	}
	now := time.Now()
	for id, lease := range s.inputLeases {
		lease.registry.Retire()
		if lease.retired.IsZero() {
			lease.retired = now
		}
		s.inputLeases[id] = lease
	}
}

// captureMutationPermit is intentionally cheap and does not reserve a lock
// across network I/O. The returned revision/epoch is revalidated by
// runPermittedMutation just before the actual side effect.
func (s *Server) captureMutationPermit(scope string) (mutationPermit, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, allowed := s.permissionLocked(scope); !allowed {
		return mutationPermit{}, false
	}
	return mutationPermit{scope: scope, revision: s.capabilityRevision, sessionEpoch: s.sessionEpoch}, true
}

func (s *Server) runPermittedMutation(permit mutationPermit, effect func() error) error {
	if effect == nil {
		return errMutationPermission
	}
	s.mutationGate.Lock()
	defer s.mutationGate.Unlock()
	s.mu.Lock()
	_, allowed := s.permissionLocked(permit.scope)
	if allowed && permit.revision != s.capabilityRevision {
		allowed = false
	}
	if allowed && permit.sessionEpoch != "" && permit.sessionEpoch != s.sessionEpoch {
		allowed = false
	}
	s.mu.Unlock()
	if !allowed {
		return errMutationPermission
	}
	return effect()
}

func permissionRejectionCode(permission Permission, fallback string) string {
	if permission.State == "revoked" {
		return "permission_revoked"
	}
	if permission.Reason != "" {
		return permission.Reason
	}
	return fallback
}

func (s *Server) rejectInput(c *websocket.Conn, code string) {
	s.mu.Lock()
	revision, epoch := s.capabilityRevision, s.sessionEpoch
	s.mu.Unlock()
	s.capabilitySendMu.Lock()
	defer s.capabilitySendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err := c.Write(ctx, websocket.MessageText, rejectedMessage(mutationScopeInput, code, revision, epoch))
	cancel()
	if err != nil {
		c.CloseNow()
	}
}

func inputMessage(message Msg) bool {
	switch message.Type {
	case "m", "b", "s", "k", "g", "t":
		return true
	default:
		return false
	}
}

func protocolForRequest(value string) (int, bool) {
	switch strings.TrimSpace(value) {
	case "", "1":
		return legacyProtocolVersion, true
	case "2":
		return protocolVersion, true
	default:
		return 0, false
	}
}
