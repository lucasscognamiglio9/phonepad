package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"phonepad/daemon/internal/input"
)

type capabilityProbe struct {
	moves  atomic.Int32
	resets atomic.Int32
}

func (p *capabilityProbe) Move(int, int)          { p.moves.Add(1) }
func (p *capabilityProbe) Button(string, bool)    {}
func (p *capabilityProbe) Scroll(int, int)        {}
func (p *capabilityProbe) Text(string)            {}
func (p *capabilityProbe) Special(string)         {}
func (p *capabilityProbe) Combo([]string, string) {}
func (p *capabilityProbe) Gesture(string)         {}
func (p *capabilityProbe) Touch([]input.Contact)  {}
func (p *capabilityProbe) Close()                 {}
func (p *capabilityProbe) Reset()                 { p.resets.Add(1) }

func (p *capabilityProbe) PointerGeometry() (input.PointerGeometry, bool) {
	return input.PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit",
		WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}, true
}

var _ input.Injector = (*capabilityProbe)(nil)

func readWSJSON(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("websocket.Read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("message type = %v, want text", typ)
	}
	var message map[string]any
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("invalid server message %q: %v", data, err)
	}
	return message
}

func dialCapabilities(t *testing.T, s *Server, query string) (*websocket.Conn, map[string]any, func()) {
	t.Helper()
	ts := httptest.NewServer(s.Handler())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if query != "" {
		wsURL += "?" + query
	}
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": {sessionCookieName + "=tok"}},
	})
	cancel()
	if err != nil {
		ts.Close()
		t.Fatalf("websocket.Dial: %v", err)
	}
	message := readWSJSON(t, c)
	cleanup := func() {
		c.CloseNow()
		ts.Close()
	}
	return c, message, cleanup
}

func TestCapabilitiesPayloadUsesPermissionAndCapabilityStates(t *testing.T) {
	viewOnly := New(staticAuth("tok"), nil, nil, "")
	viewOnly.mu.Lock()
	viewOnly.currentProtocol = protocolVersion
	viewOnly.sessionEpoch = "epoch"
	viewOnly.capabilityRevision = 4
	payload := viewOnly.capabilitiesPayloadLocked()
	viewOnly.mu.Unlock()

	if payload["t"] != "capabilities" {
		t.Fatalf("type = %v, want capabilities", payload["t"])
	}
	permissions := payload["permissions"].(Permissions)
	if permissions.Input.State != "unavailable" || permissions.Input.Reason != "provider_unavailable" {
		t.Fatalf("input permission = %+v", permissions.Input)
	}
	capabilities := payload["capabilities"].(capabilitySet)
	if capabilities.Input.State != "unavailable" || capabilities.Input.Effective || len(capabilities.Input.Actions) != 0 {
		t.Fatalf("input capability = %+v", capabilities.Input)
	}
	if capabilities.Literal.State != "unavailable" {
		t.Fatalf("literal capability = %+v, want unavailable", capabilities.Literal)
	}
	if capabilities.Input.PointerGeometry != nil {
		t.Fatalf("view-only pointer geometry = %+v, want omitted", capabilities.Input.PointerGeometry)
	}
	if got := payload["roles"].([]string); len(got) != 1 || got[0] != "viewer" {
		t.Fatalf("roles = %v, want viewer", got)
	}

	demo := New(staticAuth("tok"), &capabilityProbe{}, nil, "", WithDemo())
	demo.mu.Lock()
	demo.currentProtocol = protocolVersion
	demo.sessionEpoch = "epoch"
	demo.capabilityRevision = 2
	demoCapabilities := demo.capabilitiesPayloadLocked()
	demo.mu.Unlock()
	demoSet := demoCapabilities["capabilities"].(capabilitySet)
	if demoSet.Input.State != "available" || demoSet.Input.Effective {
		t.Fatalf("demo input capability = %+v", demoSet.Input)
	}
	if demoSet.Input.PointerGeometry == nil || demoSet.Input.PointerGeometry.Applied.ID != "legacy-100x70" || demoSet.Input.PointerGeometry.Applied.GeometryEpoch != 1 {
		t.Fatalf("demo pointer geometry = %+v", demoSet.Input.PointerGeometry)
	}
	profiles := demoSet.Input.PointerGeometry.SupportedProfiles
	if len(profiles) != 1 || profiles[0].Kind != "legacy-aspect-fit" || profiles[0].WidthMM != 100 || profiles[0].HeightMM != 70 {
		t.Fatalf("demo supported pointer profiles = %+v", profiles)
	}
	if got := demoCapabilities["roles"].([]string); len(got) != 2 || got[1] != "controller" {
		t.Fatalf("demo roles = %v", got)
	}
}

func TestCapabilitiesOmitUnconfirmedPointerGeometry(t *testing.T) {
	plain := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	plain.mu.Lock()
	plain.currentProtocol = protocolVersion
	plain.sessionEpoch = "epoch"
	payload := plain.capabilitiesPayloadLocked()
	plain.mu.Unlock()
	if got := payload["capabilities"].(capabilitySet).Input.PointerGeometry; got != nil {
		t.Fatalf("provider without geometry metadata = %+v, want omitted", got)
	}
}

func TestCapabilitiesKeepsLegacyLiteralLimitsWhenAllowed(t *testing.T) {
	p := &literalProbe{target: strings.Repeat("a", 64), outcome: "dispatched"}
	s := New(staticAuth("tok"), p, nil, "")
	s.mu.Lock()
	s.currentProtocol = protocolVersion
	s.sessionEpoch = "epoch"
	s.inputSession = "input-session"
	payload := s.capabilitiesPayloadLocked()
	s.mu.Unlock()
	if payload["input"] == nil {
		t.Fatal("v2 capabilities dropped the legacy literal limits")
	}
	if got := payload["capabilities"].(capabilitySet).Literal.State; got != "available" {
		t.Fatalf("literal state = %q, want available", got)
	}
}

func TestSetPermissionsRejectsUnsupportedViewRevocation(t *testing.T) {
	s := New(staticAuth("tok"), &capabilityProbe{}, nil, "")
	s.mu.Lock()
	before := s.permissions
	revision := s.capabilityRevision
	s.mu.Unlock()

	err := s.SetPermissions(Permissions{
		View:      Permission{State: "revoked"},
		Input:     before.Input,
		Files:     before.Files,
		Clipboard: before.Clipboard,
	})
	if !errors.Is(err, ErrViewPermissionUnsupported) {
		t.Fatalf("SetPermissions error = %v, want %v", err, ErrViewPermissionUnsupported)
	}
	s.mu.Lock()
	after := s.permissions
	s.mu.Unlock()
	if after != before {
		t.Fatalf("permissions changed after rejected view update: before=%+v after=%+v", before, after)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.capabilityRevision != revision {
		t.Fatalf("capability revision changed after rejected view update: %d -> %d", revision, s.capabilityRevision)
	}
}

func TestMutationPermitIsInvalidatedByPermissionRevision(t *testing.T) {
	s := New(staticAuth("tok"), &capabilityProbe{}, nil, "")
	permit, ok := s.captureMutationPermit(mutationScopeFiles)
	if !ok {
		t.Fatal("files permission was not granted")
	}
	var effects atomic.Int32
	if err := s.runPermittedMutation(permit, func() error {
		effects.Add(1)
		return nil
	}); err != nil {
		t.Fatalf("runPermittedMutation before revoke: %v", err)
	}
	if effects.Load() != 1 {
		t.Fatal("permitted effect did not run")
	}

	if err := s.SetPermissions(Permissions{
		View:      Permission{State: "granted"},
		Input:     Permission{State: "granted"},
		Files:     Permission{State: "revoked"},
		Clipboard: Permission{State: "granted"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.runPermittedMutation(permit, func() error {
		effects.Add(1)
		return nil
	}); !errors.Is(err, errMutationPermission) {
		t.Fatalf("stale mutation permit error = %v, want %v", err, errMutationPermission)
	}
	if effects.Load() != 1 {
		t.Fatal("stale permit ran an effect")
	}
}

func TestSessionChangeWaitsForBoundedMutationAndInvalidatesPermit(t *testing.T) {
	s := New(staticAuth("tok"), &capabilityProbe{}, nil, "")
	s.currentProtocol = protocolVersion
	s.sessionEpoch = "old-epoch"
	permit, ok := s.captureMutationPermit(mutationScopeFiles)
	if !ok {
		t.Fatal("files permission was not granted")
	}
	started := make(chan struct{})
	release := make(chan struct{})
	effectDone := make(chan error, 1)
	go func() {
		effectDone <- s.runPermittedMutation(permit, func() error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	changed := make(chan struct{})
	go func() {
		_, _ = s.setCurrent(nil, "reconnect", protocolVersion)
		close(changed)
	}()
	select {
	case <-changed:
		t.Fatal("session changed while the bounded mutation was still in progress")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	if err := <-effectDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("session change remained blocked after the bounded mutation")
	}
	if err := s.runPermittedMutation(permit, func() error { return nil }); !errors.Is(err, errMutationPermission) {
		t.Fatalf("old permit after session change = %v, want %v", err, errMutationPermission)
	}
}

func TestWSProtocolV1AndV2EpochAndPing(t *testing.T) {
	probe := &capabilityProbe{}
	s := New(staticAuth("tok"), probe, nil, "")

	legacy, hello, cleanup := dialCapabilities(t, s, "")
	if hello["t"] != "ok" {
		cleanup()
		t.Fatalf("legacy hello = %v, want ok", hello)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := legacy.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":2,"dy":1}`)); err != nil {
		cancel()
		cleanup()
		t.Fatal(err)
	}
	if err := legacy.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`)); err != nil {
		cancel()
		cleanup()
		t.Fatal(err)
	}
	cancel()
	if got := readWSJSON(t, legacy)["t"]; got != "pong" {
		cleanup()
		t.Fatalf("legacy ping response = %v", got)
	}
	cleanup()

	v2, hello, cleanup := dialCapabilities(t, s, "protocol=2")
	defer cleanup()
	if hello["t"] != "ok" {
		t.Fatalf("v2 hello = %v, want ok", hello)
	}
	if _, ok := hello["capabilities"].(map[string]any); !ok {
		t.Fatalf("v2 hello missing capabilities payload: %v", hello)
	}
	epoch, ok := hello["sessionEpoch"].(string)
	if !ok || !validSessionEpoch(epoch) || epoch == "" {
		t.Fatalf("invalid v2 session epoch %v", hello["sessionEpoch"])
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	if err := v2.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":3,"dy":0,"sessionEpoch":"`+epoch+`"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := v2.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	if got := readWSJSON(t, v2)["t"]; got != "pong" {
		t.Fatalf("v2 ping response = %v", got)
	}
	deadline := time.Now().Add(time.Second)
	for probe.moves.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := probe.moves.Load(); got != 2 {
		t.Fatalf("moves = %d, want legacy and v2 command", got)
	}

	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	if err := v2.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":9,"dy":0,"sessionEpoch":"stale"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	rejected := readWSJSON(t, v2)
	if rejected["t"] != "rejected" || rejected["code"] != "stale_session_epoch" {
		t.Fatalf("stale epoch response = %v", rejected)
	}
	if got := probe.moves.Load(); got != 2 {
		t.Fatalf("stale epoch moved injector: %d", got)
	}
}

func TestWSRevokeInputKeepsPingAndRejectsCommands(t *testing.T) {
	probe := &capabilityProbe{}
	s := New(staticAuth("tok"), probe, nil, "")
	c, hello, cleanup := dialCapabilities(t, s, "protocol=2")
	defer cleanup()
	epoch := hello["sessionEpoch"].(string)
	revision := hello["capabilityRevision"].(float64)

	if err := s.SetPermissions(Permissions{
		View:      Permission{State: "granted"},
		Input:     Permission{State: "revoked"},
		Files:     Permission{State: "granted"},
		Clipboard: Permission{State: "granted"},
	}); err != nil {
		t.Fatal(err)
	}
	update := readWSJSON(t, c)
	if update["t"] != "capabilities" || update["capabilityRevision"].(float64) <= revision {
		t.Fatalf("permission update = %v", update)
	}
	permissions := update["permissions"].(map[string]any)
	if permissions["input"].(map[string]any)["state"] != "revoked" {
		t.Fatalf("updated permission = %v", permissions["input"])
	}
	capabilities := update["capabilities"].(map[string]any)
	if capabilities["input"].(map[string]any)["state"] != "unavailable" {
		t.Fatalf("updated input capability = %v", capabilities["input"])
	}
	if capabilities["literal"].(map[string]any)["state"] != "unavailable" {
		t.Fatalf("updated literal capability = %v", capabilities["literal"])
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":1,"dy":0,"sessionEpoch":"`+epoch+`"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	rejected := readWSJSON(t, c)
	if rejected["t"] != "rejected" || rejected["code"] != "permission_revoked" {
		t.Fatalf("revoked input response = %v", rejected)
	}
	if got := readWSJSON(t, c)["t"]; got != "pong" {
		t.Fatalf("ping after revoke = %v", got)
	}
	if got := probe.moves.Load(); got != 0 {
		t.Fatalf("revoked command reached injector: %d", got)
	}
}

func TestWSReconnectRotatesEpochAndRejectsOldCommands(t *testing.T) {
	probe := &capabilityProbe{}
	s := New(staticAuth("tok"), probe, nil, "")
	old, oldHello, cleanupOld := dialCapabilities(t, s, "protocol=2")
	defer cleanupOld()
	newConn, newHello, cleanupNew := dialCapabilities(t, s, "protocol=2")
	defer cleanupNew()
	oldEpoch := oldHello["sessionEpoch"].(string)
	newEpoch := newHello["sessionEpoch"].(string)
	if oldEpoch == newEpoch {
		t.Fatalf("reconnect reused session epoch %q", oldEpoch)
	}
	old.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := newConn.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":1,"dy":0,"sessionEpoch":"`+oldEpoch+`"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	if rejected := readWSJSON(t, newConn); rejected["code"] != "stale_session_epoch" {
		t.Fatalf("old epoch after reconnect = %v", rejected)
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	if err := newConn.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":1,"dy":0,"sessionEpoch":"`+newEpoch+`"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for probe.moves.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := probe.moves.Load(); got != 1 {
		t.Fatalf("new epoch moves = %d, want 1", got)
	}
}

func TestWSReconnectClosesReplacedPeerWithPolicyViolation(t *testing.T) {
	s := New(staticAuth("tok"), &capabilityProbe{}, nil, "")
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?protocol=2"
	dial := func() *websocket.Conn {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Cookie": {sessionCookieName + "=tok"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	old := dial()
	defer old.CloseNow()
	if hello := readWSJSON(t, old); hello["t"] != "ok" {
		t.Fatalf("first hello = %v, want ok", hello)
	}

	// The first peer is intentionally left unread while the second connects.
	// Replacing it must send the 1008 reason asynchronously, otherwise a peer
	// that never answers its close handshake would block the new hello.
	newConn := dial()
	defer newConn.CloseNow()
	if hello := readWSJSON(t, newConn); hello["t"] != "ok" {
		t.Fatalf("replacement hello = %v, want ok", hello)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := old.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("replaced peer close = %v, want status 1008", err)
	}
}

func TestWSNilInjectorStartsViewOnly(t *testing.T) {
	s := New(staticAuth("tok"), nil, nil, "")
	c, hello, cleanup := dialCapabilities(t, s, "protocol=2")
	defer cleanup()
	if hello["t"] != "ok" {
		t.Fatalf("hello = %v, want ok", hello)
	}
	capabilities := hello["capabilities"].(map[string]any)
	if capabilities["input"].(map[string]any)["state"] != "unavailable" {
		t.Fatalf("input capability = %v", capabilities["input"])
	}
	if got := hello["roles"].([]any); len(got) != 1 || got[0] != "viewer" {
		t.Fatalf("roles = %v", got)
	}
	epoch := hello["sessionEpoch"].(string)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"t":"m","dx":1,"dy":0,"sessionEpoch":"`+epoch+`"}`)); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	rejected := readWSJSON(t, c)
	if rejected["t"] != "rejected" || rejected["code"] != "provider_unavailable" {
		t.Fatalf("nil provider response = %v", rejected)
	}
}
