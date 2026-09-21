package input

import (
	"context"
	"testing"
	"time"
)

type delayedActionInjector struct {
	*fakeInjector
	started chan struct{}
	release chan struct{}
	result  ActionResult
}

func (d *delayedActionInjector) SpecialAction(ctx context.Context, key string) ActionResult {
	select {
	case <-d.started:
	default:
		close(d.started)
	}
	select {
	case <-d.release:
		return d.result
	case <-ctx.Done():
		return ActionResult{State: "uncertain", Detail: "provider_context_done"}
	}
}

func (d *delayedActionInjector) ComboAction(context.Context, []string, string) ActionResult {
	return ActionResult{State: "executed", Detail: "combo_complete"}
}

func TestAsyncText_ActionReceiptWaitsForProvider(t *testing.T) {
	inner := &delayedActionInjector{
		fakeInjector: &fakeInjector{},
		started:      make(chan struct{}),
		release:      make(chan struct{}),
		result:       ActionResult{State: "executed", Detail: "provider_complete"},
	}
	a := NewAsyncText(inner, 2)
	executor, ok := a.(ActionExecutor)
	if !ok {
		t.Fatal("async injector does not expose ActionExecutor")
	}
	resultCh := make(chan ActionResult, 1)
	go func() { resultCh <- executor.SpecialAction(context.Background(), "Enter") }()
	<-inner.started
	select {
	case result := <-resultCh:
		t.Fatalf("receipt returned before provider release: %+v", result)
	case <-time.After(20 * time.Millisecond):
	}
	close(inner.release)
	select {
	case result := <-resultCh:
		if result.State != "executed" || result.Detail != "provider_complete" {
			t.Fatalf("receipt = %+v, want provider result", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for provider receipt")
	}
	a.Close()
}

func TestAsyncText_ActionReceiptTimeoutIsUncertain(t *testing.T) {
	inner := &delayedActionInjector{
		fakeInjector: &fakeInjector{},
		started:      make(chan struct{}),
		release:      make(chan struct{}),
		result:       ActionResult{State: "executed", Detail: "provider_complete"},
	}
	a := NewAsyncText(inner, 1)
	executor := a.(ActionExecutor)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := executor.SpecialAction(ctx, "Enter")
	if result.State != "uncertain" || result.Detail != "dispatch_wait_interrupted" {
		t.Fatalf("receipt = %+v, want uncertain dispatch", result)
	}
	close(inner.release)
	a.Close()
}
