package server

import (
	"context"
	"errors"
	"sync"
	"testing"

	"phonepad/daemon/internal/input"
)

type geometryController struct {
	fakeInjector
	mu            sync.Mutex
	profile       input.PointerGeometry
	calls         []input.PointerGeometry
	keepEpochZero bool
}

func (g *geometryController) PointerGeometry() (input.PointerGeometry, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.profile.ID == "" {
		return input.PointerGeometry{}, false
	}
	return g.profile, true
}

func (g *geometryController) ApplyPointerGeometry(_ context.Context, profile input.PointerGeometry) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.keepEpochZero {
		profile.GeometryEpoch = 0
		g.profile = profile
		g.calls = append(g.calls, profile)
		return nil
	}
	epoch := g.profile.GeometryEpoch
	if g.profile.ID != profile.ID || g.profile.Kind != profile.Kind || g.profile.SideMM != profile.SideMM || g.profile.WidthMM != profile.WidthMM {
		epoch++
	}
	if epoch == 0 {
		epoch = 1
	}
	profile.GeometryEpoch = epoch
	g.profile = profile
	g.calls = append(g.calls, profile)
	return nil
}

var _ input.PointerGeometryController = (*geometryController)(nil)

func TestPointerGeometryRequiresOptInAndUsesEpoch(t *testing.T) {
	controller := &geometryController{profile: input.PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}}
	profile := input.PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated", GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
	s := New(staticAuth("tok"), controller, nil, "", WithPointerCalibration(profile))
	if err := s.applyPointerGeometry(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if got, _ := controller.PointerGeometry(); got.ID != "legacy-100x70" {
		t.Fatalf("non-opted-in profile = %+v, want legacy", got)
	}
	if err := s.applyPointerGeometry(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	got, ok := controller.PointerGeometry()
	if !ok || got.ID != "square-centered" || got.GeometryEpoch != 2 {
		t.Fatalf("opted-in profile = %+v, ok=%v, want square epoch 2", got, ok)
	}
	capabilities := func() *pointerGeometryCapability {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.capabilitiesPayloadLocked()["capabilities"].(capabilitySet).Input.PointerGeometry
	}()
	if capabilities == nil || capabilities.Applied.ID != "square-centered" || capabilities.Applied.GeometryEpoch != 2 {
		t.Fatalf("wire applied profile = %+v, want square epoch 2", capabilities)
	}
}

func TestPointerGeometryRejectsUnconfirmedEpoch(t *testing.T) {
	controller := &geometryController{keepEpochZero: true}
	profile := input.PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated", GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
	s := New(staticAuth("tok"), controller, nil, "", WithPointerCalibration(profile))
	if err := s.applyPointerGeometry(context.Background(), true); !errors.Is(err, input.ErrPointerGeometryUnavailable) {
		t.Fatalf("unconfirmed geometry error = %v, want %v", err, input.ErrPointerGeometryUnavailable)
	}
	if got, ok := controller.PointerGeometry(); !ok || got.GeometryEpoch != 0 || got.ID != "square-centered" {
		t.Fatalf("controller profile = %+v, ok=%v, want unconfirmed square epoch 0", got, ok)
	}
}

func TestPointerGeometryFallsBackWhenInputPermissionRevoked(t *testing.T) {
	controller := &geometryController{profile: input.PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}}
	profile := input.PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated", GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
	s := New(staticAuth("tok"), controller, nil, "", WithPointerCalibration(profile))
	if err := s.applyPointerGeometry(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissions(Permissions{View: Permission{State: "granted"}, Input: Permission{State: "revoked"}, Files: Permission{State: "granted"}, Clipboard: Permission{State: "granted"}}); err != nil {
		t.Fatal(err)
	}
	got, ok := controller.PointerGeometry()
	if !ok || got.ID != "legacy-100x70" {
		t.Fatalf("profile after input revoke = %+v, ok=%v, want legacy", got, ok)
	}
	if len(controller.calls) != 2 {
		t.Fatalf("geometry applications = %d, want square then legacy", len(controller.calls))
	}
}

func TestPointerGeometryRestoresOptedInProfileAfterPermissionGrant(t *testing.T) {
	controller := &geometryController{profile: input.PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}}
	profile := input.PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated", GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
	s := New(staticAuth("tok"), controller, nil, "", WithPointerCalibration(profile))
	s.mu.Lock()
	s.pointerGeometryOptIn = true
	s.currentProtocol = protocolVersion
	s.mu.Unlock()
	if err := s.applyPointerGeometry(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissions(Permissions{View: Permission{State: "granted"}, Input: Permission{State: "revoked"}, Files: Permission{State: "granted"}, Clipboard: Permission{State: "granted"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissions(Permissions{View: Permission{State: "granted"}, Input: Permission{State: "granted"}, Files: Permission{State: "granted"}, Clipboard: Permission{State: "granted"}}); err != nil {
		t.Fatal(err)
	}
	got, ok := controller.PointerGeometry()
	if !ok || got.ID != "square-centered" || got.GeometryEpoch != 4 {
		t.Fatalf("profile after permission restore = %+v, ok=%v, want square epoch 4", got, ok)
	}
}

func TestSetCurrentNegotiatesProfileBeforeSendingSessionHello(t *testing.T) {
	controller := &geometryController{profile: input.PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}}
	profile := input.PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated", GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
	s := New(staticAuth("tok"), controller, nil, "", WithPointerCalibration(profile))
	if _, err := s.setCurrent(nil, "new-peer", protocolVersion, true); err != nil {
		t.Fatal(err)
	}
	got, ok := controller.PointerGeometry()
	if !ok || got.ID != "square-centered" || got.GeometryEpoch != 2 {
		t.Fatalf("negotiated profile = %+v, ok=%v, want square epoch 2", got, ok)
	}
	s.mu.Lock()
	if s.sessionEpoch == "" || s.currentProtocol != protocolVersion {
		s.mu.Unlock()
		t.Fatalf("session state = protocol %d epoch %q, want v2 with epoch", s.currentProtocol, s.sessionEpoch)
	}
	s.mu.Unlock()
	if _, err := s.setCurrent(nil, "legacy-peer", legacyProtocolVersion, false); err != nil {
		t.Fatal(err)
	}
	got, ok = controller.PointerGeometry()
	if !ok || got.ID != "legacy-100x70" || got.GeometryEpoch != 3 {
		t.Fatalf("legacy reconnect profile = %+v, ok=%v, want legacy epoch 3", got, ok)
	}
}
