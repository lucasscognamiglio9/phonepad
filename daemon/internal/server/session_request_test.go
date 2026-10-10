package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPPermitCannotCrossControlSession(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.currentProtocol = protocolVersion
	s.sessionEpoch = "old"
	r := httptest.NewRequest("POST", "https://phonepad/api/file-transfers", nil)
	r.Header.Set("X-PhonePad-Session", "old")
	if !s.acceptRequestSession(httptest.NewRecorder(), r) {
		t.Fatal("initial session rejected")
	}
	s.sessionEpoch = "new"
	if _, ok := s.captureRequestMutationPermit(r, mutationScopeFiles); ok {
		t.Fatal("captured a permit from a different control session")
	}
	if err := s.observeMedia(1, unknownMedia("stale response"), "old"); err != nil {
		t.Fatal(err)
	}
	if s.media.applied != 0 {
		t.Fatal("stale media became current")
	}
}
func TestMediaContextCancelsWithControlSession(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.currentProtocol = protocolVersion
	s.sessionEpoch = "current"
	session, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.controlCtx = session
	r := httptest.NewRequest("POST", "https://phonepad/api/preview/rtc", nil)
	r.Header.Set("X-PhonePad-Session", "current")
	ctx, release, ok := s.requestSessionContext(r)
	defer release()
	if !ok {
		t.Fatal("session rejected")
	}
	if ctx.Err() != nil {
		t.Fatal("view context unavailable")
	}
	cancel()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("old media context remained alive")
	}
}
