package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mediaFixture(id string, epoch uint64) mediaSnapshot {
	return mediaSnapshot{Version: 1, Source: mediaSource{State: "available", ID: id, Kind: "portal"},
		Geometry: mediaGeometry{State: "available", Epoch: epoch, Width: 2731, Height: 1537, EncodedWidth: 1920, EncodedHeight: 1080},
		Video:    mediaVideo{State: "available", Codecs: []string{"H264"}, SelectedCodec: "H264"}}
}

func TestPreviewMetadataIsObservedWithoutOpeningCaptureForControl(t *testing.T) {
	old := previewClient
	defer func() { previewClient = old }()
	count := 0
	data, _ := json.Marshal(map[string]any{"state": "ready", "media": mediaFixture("source-a", 1)})
	previewClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		count++
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.mu.Lock()
	s.currentProtocol, s.sessionEpoch = protocolVersion, "control-a"
	beforeRevision := s.capabilityRevision
	before := s.capabilitiesPayloadLocked()
	s.mu.Unlock()
	if count != 0 || before["media"].(mediaSnapshot).Geometry.State != "unknown" {
		t.Fatal("control queried capture or fabricated geometry")
	}
	for range 2 {
		r := localRequest("GET", "/api/preview/status")
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "tok"})
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 || w.Body.String() != string(data) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessionEpoch != "control-a" || s.capabilityRevision != beforeRevision+1 || count != 2 {
		t.Fatal("stable media changed the control epoch or repeatedly bumped its revision")
	}
	payload := s.capabilitiesPayloadLocked()
	geometry := payload["geometry"].(geometryCapability)
	if geometry.Width != 2731 || geometry.EncodedWidth != 1920 || *geometry.GeometryEpoch != 1 {
		t.Fatal("capture geometry was replaced by the encoder bounds")
	}
}

func TestMediaObservationsRejectReusedEpochAndIgnoreOutOfOrderReplies(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	a, b := s.beginMediaObservation(), s.beginMediaObservation()
	if err := s.observeMedia(b, mediaFixture("source-b", 1)); err != nil {
		t.Fatal(err)
	}
	if err := s.observeMedia(a, mediaFixture("source-a", 1)); err != nil {
		t.Fatal(err)
	}
	if s.media.snapshot.Source.ID != "source-b" {
		t.Fatal("late response replaced the current source")
	}
	changed := mediaFixture("source-b", 1)
	changed.Geometry.Width = 3000
	if err := s.observeMedia(s.beginMediaObservation(), unknownMedia("caps_pending")); err != nil {
		t.Fatal(err)
	}
	if err := s.observeMedia(s.beginMediaObservation(), changed); err == nil {
		t.Fatal("missing caps allowed a reused geometry epoch")
	}
	changed.Geometry.Epoch++
	if err := s.observeMedia(s.beginMediaObservation(), changed); err != nil {
		t.Fatal(err)
	}
	if err := s.observeMedia(s.beginMediaObservation(), mediaFixture("source-b", 1)); err == nil {
		t.Fatal("geometry went backwards")
	}
	if err := s.observeMedia(s.beginMediaObservation(), mediaFixture("restarted-source", 1)); err != nil {
		t.Fatal(err)
	}
}

func TestMediaChangeDoesNotRevokeAnAdmittedFileTransfer(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	permit, ok := s.captureMutationPermit(mutationScopeFiles)
	if !ok {
		t.Fatal("missing file permission")
	}
	if err := s.observeMedia(s.beginMediaObservation(), mediaFixture("source-a", 1)); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := s.runPermittedMutation(permit, func() error { called = true; return nil }); err != nil || !called {
		t.Fatal("video metadata invalidated an unrelated file upload", err)
	}
	permissions := defaultPermissions(s.inj)
	permissions.Files = Permission{State: "revoked"}
	if err := s.SetPermissions(permissions); err != nil {
		t.Fatal(err)
	}
	if err := s.runPermittedMutation(permit, func() error { t.Fatal("revoked file upload ran"); return nil }); err == nil {
		t.Fatal("revoked permit accepted")
	}
}

func TestMediaValidationAndAging(t *testing.T) {
	value := mediaFixture("source-a", 1)
	data, _ := json.Marshal(value)
	if _, err := parseMediaSnapshot(data); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*mediaSnapshot){
		func(m *mediaSnapshot) { m.Version = 9 },
		func(m *mediaSnapshot) { m.Source.ID = "../private-node" },
		func(m *mediaSnapshot) { m.Geometry.Width = 0 },
		func(m *mediaSnapshot) { m.Geometry.Epoch = maxSafeMediaEpoch + 1 },
		func(m *mediaSnapshot) { m.Video.SelectedCodec = "H265" },
		func(m *mediaSnapshot) { m.Geometry.State = "unknown" },
	} {
		bad := mediaFixture("source-a", 1)
		mutate(&bad)
		encoded, _ := json.Marshal(bad)
		if _, err := parseMediaSnapshot(encoded); err == nil {
			t.Fatalf("invalid metadata accepted: %s", encoded)
		}
	}
	s := New(staticAuth("tok"), nil, nil, "")
	if err := s.observeMedia(s.beginMediaObservation(), value); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.media.observed = time.Now().Add(-2 * mediaSnapshotTTL)
	stale := s.mediaSnapshotLocked()
	s.mu.Unlock()
	if stale.Source.ID != "" || stale.Geometry.State != "unknown" {
		t.Fatal("expired metadata advertised as current")
	}
}
