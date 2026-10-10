package server

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"phonepad/daemon/internal/input"
)

// ErrServerClosing is returned to a request that races with the lifecycle
// barrier. The barrier is deliberately shared by the local and gateway
// handlers, so a listener cannot admit work after shutdown has started.
var ErrServerClosing = errors.New("server is shutting down")

const shutdownCleanupTimeout = 10 * time.Second

// lifecycle state is kept on Server rather than on an http.Server: the same
// Server is exposed by the LAN listener and by the loopback gateway, while
// WebSockets are hijacked and therefore outside net/http Shutdown's tracking.
func (s *Server) isClosing() bool {
	s.lifecycleMu.Lock()
	closing := s.lifecycleClosing
	s.lifecycleMu.Unlock()
	return closing
}

func (s *Server) rejectIfClosing(w http.ResponseWriter) bool {
	if !s.isClosing() {
		return false
	}
	http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
	return true
}

// contextWithLifecycle keeps a hijacked handler alive after ServeMux returns,
// while still cancelling it as soon as Shutdown begins. The returned cancel
// also removes the AfterFunc for ordinary request completion.
func (s *Server) contextWithLifecycle(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	s.lifecycleMu.Lock()
	lifecycle := s.lifecycleCtx
	if lifecycle == nil {
		lifecycle = context.Background()
	}
	s.lifecycleMu.Unlock()
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(lifecycle, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// Shutdown stops admission and retires the input session exactly once. The
// first caller starts the single cleanup coordinator; every caller waits for
// that same result or its own deadline. A provider that ignores context may
// continue unwinding in its worker, but this method never keeps a server mutex
// while waiting for that provider.
func (s *Server) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	var start bool
	s.lifecycleMu.Lock()
	if !s.lifecycleClosing {
		s.lifecycleClosing = true
		if s.lifecycleCancel != nil {
			s.lifecycleCancel()
		}
		// The channel is initialized by New. Keep the zero-value fallback useful
		// for small package tests that construct a Server directly.
		if s.lifecycleDone == nil {
			s.lifecycleDone = make(chan struct{})
		}
		start = true
	}
	done := s.lifecycleDone
	err := s.lifecycleErr
	s.lifecycleMu.Unlock()
	if start {
		// The coordinator owns cleanup after admission is closed. A caller with
		// a short deadline must be able to return even if an older provider or
		// upload currently holds mutationGate; the coordinator continues and
		// publishes the eventual result through lifecycleDone.
		cleanupCtx, cancelCleanup := shutdownContext(ctx)
		go func() {
			defer cancelCleanup()
			err := s.shutdownResources(cleanupCtx)
			s.lifecycleMu.Lock()
			s.lifecycleErr = err
			close(done)
			s.lifecycleMu.Unlock()
		}()
	}

	if done == nil {
		return err
	}
	select {
	case <-done:
		s.lifecycleMu.Lock()
		err = s.lifecycleErr
		s.lifecycleMu.Unlock()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func shutdownContext(caller context.Context) (context.Context, context.CancelFunc) {
	remaining := shutdownCleanupTimeout
	if deadline, ok := caller.Deadline(); ok {
		if d := time.Until(deadline); d > 0 && d < remaining {
			remaining = d
		}
	}
	return context.WithTimeout(context.Background(), remaining)
}

// runLifecycleMutation is the admission-aware variant for input effects. The
// older permit helper is also used by storage code, but a control frame must
// be rejected if shutdown won the race after the permit was captured and
// before the effect reached the gate.
func (s *Server) runLifecycleMutation(permit mutationPermit, effect func() error) error {
	if effect == nil {
		return errMutationPermission
	}
	s.mutationGate.Lock()
	defer s.mutationGate.Unlock()
	s.lifecycleMu.Lock()
	closing := s.lifecycleClosing
	s.lifecycleMu.Unlock()
	if closing {
		return ErrServerClosing
	}
	s.mu.Lock()
	_, allowed := s.permissionLocked(permit.scope)
	if allowed && (permit.revision != s.permissionRevision || permit.generation != s.gen) {
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

func (s *Server) shutdownResources(ctx context.Context) error {
	// The same order as permission/session mutation. No socket or provider I/O
	// occurs while either lock is held.
	s.mutationGate.Lock()
	s.mu.Lock()
	current := s.current
	disconnected := current != nil
	s.current = nil
	s.currentProtocol = 0
	s.sessionEpoch = ""
	s.inputSession = ""
	s.capabilityRevision++
	s.gen++
	s.retireInputLeasesLocked()
	s.mu.Unlock()
	s.mutationGate.Unlock()

	s.desktop.mu.Lock()
	publisher, viewer := s.desktop.publisher, s.desktop.viewer
	s.desktop.publisher, s.desktop.viewer = nil, nil
	s.desktop.mu.Unlock()

	if disconnected && s.hub != nil {
		s.hub.clientDisconnected()
	}

	closeErr := closeWebSockets(ctx, current, publisher, viewer)
	resetErr := resetInjectorContext(ctx, s.inj)
	if closeErr != nil {
		return closeErr
	}
	return resetErr
}

func closeWebSockets(ctx context.Context, connections ...*websocket.Conn) error {
	var wg sync.WaitGroup
	for _, c := range connections {
		if c == nil {
			continue
		}
		wg.Add(1)
		go func(c *websocket.Conn) {
			defer wg.Done()
			_ = c.CloseNow()
		}(c)
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func resetInjectorContext(ctx context.Context, inj input.Injector) error {
	if inj == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if resetter, ok := inj.(input.ContextResetter); ok {
		return resetter.ResetContext(ctx)
	}
	done := make(chan struct{})
	go func() {
		resetInjector(inj)
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Called while mutationGate serializes the transition, with Server.mu released.
// An incomplete physical reset leaves control unavailable until a subsequent
// explicit transition successfully resets the provider. Preview remains usable.
func (s *Server) resetForTransition() error {
	ctx, cancelLifecycle := s.contextWithLifecycle(context.Background())
	defer cancelLifecycle()
	ctx, cancelTimeout := context.WithTimeout(ctx, 5*time.Second)
	defer cancelTimeout()
	err := resetInjectorContext(ctx, s.inj)
	s.mu.Lock()
	s.inputResetIncomplete = err != nil
	s.mu.Unlock()
	return err
}

func closeInjectorContext(ctx context.Context, inj input.Injector) error {
	if inj == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if closer, ok := inj.(input.ContextCloser); ok {
		return closer.CloseContext(ctx)
	}
	done := make(chan struct{})
	go func() {
		inj.Close()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
