package server

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"phonepad/daemon/internal/input"
)

type orderedReceiptInjector struct {
	fakeInjector
	mu      sync.Mutex
	started chan struct{}
	release chan struct{}
	calls   []string
}

func (i *orderedReceiptInjector) SpecialAction(ctx context.Context, key string) input.ActionResult {
	i.mu.Lock()
	call := len(i.calls)
	i.calls = append(i.calls, key)
	i.mu.Unlock()
	if call == 0 {
		close(i.started)
		select {
		case <-i.release:
		case <-ctx.Done():
			return input.ActionResult{State: "uncertain", Detail: "provider_context_done"}
		}
	}
	return input.ActionResult{State: "executed", Detail: "provider_complete"}
}

func (i *orderedReceiptInjector) ComboAction(context.Context, []string, string) input.ActionResult {
	return input.ActionResult{State: "executed", Detail: "provider_complete"}
}

func (i *orderedReceiptInjector) callCount() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.calls)
}

func waitForActionSequence(t *testing.T, s *Server, operationID string, sequence uint64) {
	t.Helper()
	// The test observes the reservation itself, rather than sleeping for an
	// arbitrary interval. This makes the race deterministic while retaining a
	// bounded failure if admission regresses.
	for attempts := 0; attempts < 100000; attempts++ {
		s.mu.Lock()
		op, found := s.actionOps[operationID]
		_, reserved := op.sequenceDone[sequence]
		s.mu.Unlock()
		if found && reserved {
			return
		}
		runtime.Gosched()
	}
	t.Fatalf("operation %q sequence %d was not reserved", operationID, sequence)
}

var _ input.ActionExecutor = (*orderedReceiptInjector)(nil)

type receiptInjector struct {
	fakeInjector
	specialResult input.ActionResult
	comboResult   input.ActionResult
	specialCalls  int
	comboCalls    int
	started       chan struct{}
	release       chan struct{}
}

func (r *receiptInjector) SpecialAction(ctx context.Context, key string) input.ActionResult {
	r.specialCalls++
	if r.started != nil {
		select {
		case <-r.started:
		default:
			close(r.started)
		}
	}
	if r.release != nil {
		select {
		case <-r.release:
		case <-ctx.Done():
			return input.ActionResult{State: "uncertain", Detail: "provider_context_done"}
		}
	}
	return r.specialResult
}

func (r *receiptInjector) ComboAction(context.Context, []string, string) input.ActionResult {
	r.comboCalls++
	return r.comboResult
}

func actionPermit(s *Server, epoch string) mutationPermit {
	s.mu.Lock()
	s.sessionEpoch = epoch
	s.currentProtocol = protocolVersion
	s.gen = 1
	revision := s.permissionRevision
	s.mu.Unlock()
	return mutationPermit{scope: mutationScopeInput, revision: revision, generation: 1, sessionEpoch: epoch}
}

func TestActionReceiptWaitsForProviderAndDeduplicatesPress(t *testing.T) {
	inj := &receiptInjector{
		specialResult: input.ActionResult{State: "executed", Detail: "provider_complete"},
		started:       make(chan struct{}),
		release:       make(chan struct{}),
	}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-1")
	resultCh := make(chan actionReceipt, 1)
	go func() {
		resultCh <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "Enter", OperationID: "op-1", Phase: "press", SessionEpoch: "epoch-1",
		})
	}()
	<-inj.started
	select {
	case result := <-resultCh:
		t.Fatalf("receipt returned before provider release: %+v", result)
	case <-time.After(20 * time.Millisecond):
	}
	close(inj.release)
	result := <-resultCh
	if result.State != "executed" || result.Detail != "provider_complete" {
		t.Fatalf("receipt = %+v, want executed provider receipt", result)
	}
	replay := s.routeKeyOperation(context.Background(), permit, Msg{
		Type: "k", Action: "special", Key: "Enter", OperationID: "op-1", Phase: "press", SessionEpoch: "epoch-1",
	})
	if !replay.Replayed || replay.State != "executed" || inj.specialCalls != 1 {
		t.Fatalf("duplicate press = %+v, calls=%d; want replay without provider call", replay, inj.specialCalls)
	}
}

func TestActionReceiptSequenceGapReplayAndCancel(t *testing.T) {
	inj := &receiptInjector{
		specialResult: input.ActionResult{State: "executed", Detail: "provider_complete"},
		comboResult:   input.ActionResult{State: "executed", Detail: "combo_complete"},
	}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-2")
	base := Msg{Type: "k", Action: "combo", Mods: []string{"ctrl"}, Key: "c", OperationID: "op-2", SessionEpoch: "epoch-2"}
	press := s.routeKeyOperation(context.Background(), permit, base)
	if press.State != "executed" {
		t.Fatalf("press = %+v, want executed", press)
	}
	repeat := base
	repeat.Phase = "repeat"
	repeat.ActionSequence = 2
	repeatReceipt := s.routeKeyOperation(context.Background(), permit, repeat)
	if repeatReceipt.State != "executed" || repeatReceipt.RepeatCount != 1 {
		t.Fatalf("repeat = %+v, want first repeat executed", repeatReceipt)
	}
	replay := s.routeKeyOperation(context.Background(), permit, repeat)
	if !replay.Replayed || replay.RepeatCount != 1 || inj.comboCalls != 2 {
		t.Fatalf("repeat replay = %+v, combo calls=%d", replay, inj.comboCalls)
	}
	gap := repeat
	gap.ActionSequence = 4
	gapReceipt := s.routeKeyOperation(context.Background(), permit, gap)
	if gapReceipt.State != "rejected" || gapReceipt.Detail != "sequence_gap" {
		t.Fatalf("gap = %+v, want sequence_gap rejection", gapReceipt)
	}
	cancel := base
	cancel.Action = "cancel"
	cancel.Key = ""
	cancel.Mods = nil
	cancel.Phase = "cancel"
	cancel.ActionSequence = 0
	cancelReceipt := s.routeKeyOperation(context.Background(), permit, cancel)
	if cancelReceipt.State != "cancelled" || cancelReceipt.RepeatCount != 1 {
		t.Fatalf("cancel = %+v, want cancelled after one repeat", cancelReceipt)
	}
	late := repeat
	late.ActionSequence = 3
	lateReceipt := s.routeKeyOperation(context.Background(), permit, late)
	if lateReceipt.State != "rejected" || lateReceipt.Detail != "operation_cancelled" || inj.comboCalls != 2 {
		t.Fatalf("late repeat = %+v, calls=%d", lateReceipt, inj.comboCalls)
	}
}

func TestActionReceiptUncertainStopsRepeat(t *testing.T) {
	inj := &receiptInjector{specialResult: input.ActionResult{State: "uncertain", Detail: "provider_failed_after_write"}}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-3")
	base := Msg{Type: "k", Action: "special", Key: "Enter", OperationID: "op-3", Phase: "press", SessionEpoch: "epoch-3"}
	press := s.routeKeyOperation(context.Background(), permit, base)
	if press.State != "uncertain" {
		t.Fatalf("press = %+v, want uncertain", press)
	}
	repeat := base
	repeat.Phase = "repeat"
	repeat.ActionSequence = 2
	got := s.routeKeyOperation(context.Background(), permit, repeat)
	if got.State != "rejected" || got.Detail != "operation_cancelled" || inj.specialCalls != 1 {
		t.Fatalf("repeat after uncertain = %+v, calls=%d", got, inj.specialCalls)
	}
}

func TestActionReceiptLegacyProviderIsAdmissionOnly(t *testing.T) {
	inj := &fakeInjector{}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-4")
	got := s.routeKeyOperation(context.Background(), permit, Msg{
		Type: "k", Action: "special", Key: "Enter", OperationID: "op-4", Phase: "press", SessionEpoch: "epoch-4",
	})
	if got.State != "admitted" || got.Detail != "provider_execution_unobserved" {
		t.Fatalf("receipt = %+v, want admission-only result", got)
	}
	if len(inj.specials) != 1 || inj.specials[0] != "Enter" {
		t.Fatalf("legacy provider calls = %v, want one Enter", inj.specials)
	}
}

func TestActionReceiptConcurrentRepeatWaitsForPressProvider(t *testing.T) {
	inj := &orderedReceiptInjector{started: make(chan struct{}), release: make(chan struct{})}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-order")
	pressDone := make(chan actionReceipt, 1)
	go func() {
		pressDone <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-order", Phase: "press", ActionSequence: 1, SessionEpoch: "epoch-order",
		})
	}()
	<-inj.started
	repeatDone := make(chan actionReceipt, 1)
	go func() {
		repeatDone <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-order", Phase: "repeat", ActionSequence: 2, SessionEpoch: "epoch-order",
		})
	}()
	duplicateDone := make(chan actionReceipt, 1)
	go func() {
		duplicateDone <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-order", Phase: "repeat", ActionSequence: 2, SessionEpoch: "epoch-order",
		})
	}()
	waitForActionSequence(t, s, "op-order", 2)
	if got := inj.callCount(); got != 1 {
		t.Fatalf("provider calls while press blocked = %d, want 1", got)
	}
	select {
	case got := <-repeatDone:
		t.Fatalf("repeat overtook blocked press: %+v", got)
	default:
	}
	close(inj.release)
	press := <-pressDone
	repeat := <-repeatDone
	duplicate := <-duplicateDone
	if press.State != "executed" || repeat.State != "executed" || repeat.RepeatCount != 1 {
		t.Fatalf("press=%+v repeat=%+v, want ordered executed receipts", press, repeat)
	}
	if duplicate.State != "executed" || repeat.Replayed == duplicate.Replayed {
		t.Fatalf("repeat=%+v duplicate=%+v, want one provider receipt and one replay", repeat, duplicate)
	}
	if got := inj.callCount(); got != 2 {
		t.Fatalf("provider calls = %d, want press then one repeat", got)
	}
}

func TestActionReceiptCancelStopsQueuedRepeatButPreservesLatePressResult(t *testing.T) {
	inj := &orderedReceiptInjector{started: make(chan struct{}), release: make(chan struct{})}
	s := New(staticAuth("tok"), inj, nil, "")
	permit := actionPermit(s, "epoch-cancel")
	pressDone := make(chan actionReceipt, 1)
	go func() {
		pressDone <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-cancel", Phase: "press", ActionSequence: 1, SessionEpoch: "epoch-cancel",
		})
	}()
	<-inj.started
	repeatDone := make(chan actionReceipt, 1)
	go func() {
		repeatDone <- s.routeKeyOperation(context.Background(), permit, Msg{
			Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-cancel", Phase: "repeat", ActionSequence: 2, SessionEpoch: "epoch-cancel",
		})
	}()
	waitForActionSequence(t, s, "op-cancel", 2)
	cancel := s.routeKeyOperation(context.Background(), permit, Msg{
		Type: "k", Action: "cancel", OperationID: "op-cancel", Phase: "cancel", SessionEpoch: "epoch-cancel",
	})
	if cancel.State != "cancelled" {
		t.Fatalf("cancel = %+v, want cancelled", cancel)
	}
	queued := <-repeatDone
	if queued.State != "rejected" || queued.Detail != "operation_cancelled" {
		t.Fatalf("queued repeat after cancel = %+v", queued)
	}
	close(inj.release)
	press := <-pressDone
	if press.State != "executed" || press.Detail != "executed_after_cancel" {
		t.Fatalf("late press receipt = %+v, want executed provider result", press)
	}
	if got := inj.callCount(); got != 1 {
		t.Fatalf("provider calls after cancel = %d, want no late repeat", got)
	}
	s.mu.Lock()
	op := s.actionOps["op-cancel"]
	s.mu.Unlock()
	if !op.cancelled || op.active || op.state != "cancelled" {
		t.Fatalf("operation terminal state overwritten: %+v", op)
	}
	late := s.routeKeyOperation(context.Background(), permit, Msg{
		Type: "k", Action: "special", Key: "ArrowUp", OperationID: "op-cancel", Phase: "repeat", ActionSequence: 3, SessionEpoch: "epoch-cancel",
	})
	if late.State != "rejected" || late.Detail != "operation_cancelled" {
		t.Fatalf("late repeat = %+v", late)
	}
}
