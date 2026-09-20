package server

import (
	"context"
	"errors"
	"testing"
	"time"
)

type resetProbe struct {
	fakeInjector
	failure error
	started chan struct{}
	release chan struct{}
}

func (p *resetProbe) ResetContext(ctx context.Context) error {
	if p.started != nil {
		close(p.started)
		select {
		case <-p.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return p.failure
}

func TestIncompleteResetKeepsViewAndDisablesInputUntilRecovery(t *testing.T) {
	p := &resetProbe{failure: context.DeadlineExceeded}
	s := New(staticAuth("tok"), p, nil, "")
	s.mutationGate.Lock()
	err := s.resetForTransition()
	s.mutationGate.Unlock()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	s.mu.Lock()
	permissions := s.effectivePermissionsLocked()
	s.mu.Unlock()
	if permissions.Input.Reason != "input_reset_incomplete" || permissions.View.State != "granted" {
		t.Fatal("failed reset did not preserve a usable view-only session", permissions)
	}
	if _, allowed := s.captureMutationPermit(mutationScopeInput); allowed {
		t.Fatal("input admitted before its reset completed")
	}
	p.failure = nil
	if err := s.SetPermissions(defaultPermissions(p)); err != nil {
		t.Fatal(err)
	}
	if _, allowed := s.captureMutationPermit(mutationScopeInput); !allowed {
		t.Fatal("successful explicit recovery did not restore input")
	}
}

func TestPermissionResetDoesNotHoldSessionStateMutex(t *testing.T) {
	p := &resetProbe{started: make(chan struct{}), release: make(chan struct{})}
	s := New(staticAuth("tok"), p, nil, "")
	permissions := defaultPermissions(p)
	permissions.Input = Permission{State: "revoked"}
	done := make(chan error, 1)
	go func() { done <- s.SetPermissions(permissions) }()
	<-p.started
	stateRead := make(chan Permissions, 1)
	go func() {
		s.mu.Lock()
		stateRead <- s.effectivePermissionsLocked()
		s.mu.Unlock()
	}()
	select {
	case state := <-stateRead:
		if state.Input.State != "revoked" {
			close(p.release)
			t.Fatal("revocation not visible during reset")
		}
	case <-time.After(time.Second):
		close(p.release)
		t.Fatal("provider reset retained the session mutex")
	}
	close(p.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
