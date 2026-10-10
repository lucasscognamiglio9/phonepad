package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"phonepad/daemon/internal/input"
)

func TestLifecycleRejectsNewAdmissionsAndIsIdempotent(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	before := httptest.NewRecorder()
	s.Handler().ServeHTTP(before, localRequest(http.MethodGet, "/api/mode"))
	if before.Code != http.StatusOK {
		t.Fatalf("pre-shutdown request status = %d, want 200", before.Code)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	after := httptest.NewRecorder()
	s.Handler().ServeHTTP(after, localRequest(http.MethodGet, "/api/mode"))
	if after.Code != http.StatusServiceUnavailable {
		t.Fatalf("post-shutdown request status = %d, want 503", after.Code)
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("second Shutdown: %v", err)
	}
}

func TestLifecycleCancelsHijackedContext(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	ctx, cancel := s.contextWithLifecycle(context.Background())
	defer cancel()
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("lifecycle did not cancel the handler context")
	}
}

func TestRemoteHandlerRejectsAfterShutdown(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	r := httptest.NewRequest(http.MethodGet, "https://phone.example/api/mode", nil)
	r.Host = "phone.example"
	r.RemoteAddr = "127.0.0.1:4321"
	w := httptest.NewRecorder()
	s.RemoteHandler("https://phone.example").ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("gateway request status = %d, want 503", w.Code)
	}
}

func TestLifecycleCallerDeadlineDoesNotWaitForMutationGate(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.mutationGate.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	start := time.Now()
	err := s.Shutdown(ctx)
	elapsed := time.Since(start)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want deadline exceeded", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Shutdown waited %v on a busy mutation gate", elapsed)
	}
	// Let the single coordinator finish its eventual cleanup. This also keeps
	// the test from leaving a goroutine blocked on the deliberately held gate.
	s.mutationGate.Unlock()
	wait, cancelWait := context.WithTimeout(context.Background(), time.Second)
	defer cancelWait()
	if err := s.Shutdown(wait); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("coordinator cleanup: %v", err)
	}
}

var _ input.Injector = (*fakeInjector)(nil)
