package server

import (
	"context"
	"testing"
	"time"

	"phonepad/daemon/internal/input"
)

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
