package server

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"

	"phonepad/daemon/internal/input"
)

const maxActionOperations = 128

type actionOperation struct {
	sessionEpoch string
	action       string
	key          string
	mods         []string
	active       bool
	state        string
	repeatCount  int
	nextSequence uint64
	cancelled    bool
	receipts     map[uint64]actionReceipt
	sequenceDone map[uint64]chan struct{}
	// dispatchMu serializes the short admission decision with cancel. The
	// provider itself runs outside this lock so cancel can mark an in-flight
	// action immediately, while a future action cannot pass the same gate.
	dispatchMu *sync.Mutex
}

// routeKeyOperation gives protocol-v2 key actions an idempotent, bounded
// receipt. A legacy action without operationId keeps the old admission-only
// behavior and is routed by routeInjector in server.go. Repeat never creates a new
// operation, and cancel only stops future repeats: it cannot claim that a key
// already accepted by a provider was undone.
func (s *Server) routeKeyOperation(ctx context.Context, permit mutationPermit, m Msg) actionReceipt {
	phase := m.Phase
	if phase == "" {
		phase = "press"
	}
	if m.Action == "cancel" {
		s.mu.Lock()
		op, ok := s.actionOps[m.OperationID]
		dispatchMu := op.dispatchMu
		valid := ok && op.sessionEpoch == permit.sessionEpoch
		s.mu.Unlock()
		if !valid {
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if dispatchMu != nil {
			dispatchMu.Lock()
			defer dispatchMu.Unlock()
		}
		s.mu.Lock()
		op, ok = s.actionOps[m.OperationID]
		if !ok || op.sessionEpoch != permit.sessionEpoch {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if op.cancelled {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "cancelled", RepeatCount: op.repeatCount, Replayed: true, SessionEpoch: permit.sessionEpoch}
		}
		detail := ""
		if op.state == "uncertain" {
			detail = "repeat_stopped_after_uncertain"
		}
		op.active = false
		op.cancelled = true
		op.state = "cancelled"
		for sequence, done := range op.sequenceDone {
			close(done)
			delete(op.sequenceDone, sequence)
		}
		s.actionOps[m.OperationID] = op
		s.mu.Unlock()
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "cancelled", RepeatCount: op.repeatCount, Detail: detail, SessionEpoch: permit.sessionEpoch}
	}

	s.mu.Lock()
	if s.actionOps == nil {
		s.actionOps = make(map[string]actionOperation)
	}
	op, exists := s.actionOps[m.OperationID]
	if exists {
		if op.sessionEpoch != permit.sessionEpoch || op.action != m.Action || op.key != m.Key || !sameStrings(op.mods, m.Mods) {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "operation_conflict", SessionEpoch: permit.sessionEpoch}
		}
		if phase == "press" {
			if m.ActionSequence > 1 {
				s.mu.Unlock()
				return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "sequence_conflict", SessionEpoch: permit.sessionEpoch}
			}
			receipt, found := op.receipts[1]
			if !found {
				state := op.state
				if state == "" || state == "pending" {
					state = "uncertain"
				}
				receipt = actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: state, RepeatCount: op.repeatCount, SessionEpoch: permit.sessionEpoch}
			}
			receipt.Replayed = true
			s.mu.Unlock()
			return receipt
		}
		if !op.active {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "operation_cancelled", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence < op.nextSequence {
			receipt, found := op.receipts[m.ActionSequence]
			if found {
				receipt.Replayed = true
				s.mu.Unlock()
				return receipt
			}
			pending := op.sequenceDone[m.ActionSequence]
			s.mu.Unlock()
			if pending != nil {
				if ctx == nil {
					ctx = context.Background()
				}
				select {
				case <-pending:
					s.mu.Lock()
					op = s.actionOps[m.OperationID]
					receipt, found = op.receipts[m.ActionSequence]
					s.mu.Unlock()
					if found {
						receipt.Replayed = true
						return receipt
					}
				case <-ctx.Done():
				}
			}
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "sequence_unknown", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence > op.nextSequence {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "sequence_gap", SessionEpoch: permit.sessionEpoch}
		}
		if op.repeatCount >= maxActionOperations {
			op.active = false
			op.state = "rejected"
			s.actionOps[m.OperationID] = op
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "repeat_limit", SessionEpoch: permit.sessionEpoch}
		}
		op.repeatCount++
		op.nextSequence++
		if op.sequenceDone == nil {
			op.sequenceDone = make(map[uint64]chan struct{})
		}
		op.sequenceDone[m.ActionSequence] = make(chan struct{})
		s.actionOps[m.OperationID] = op
	} else {
		if phase != "press" {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if len(s.actionOps) >= maxActionOperations {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "operation_capacity", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence > 1 {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "sequence_conflict", SessionEpoch: permit.sessionEpoch}
		}
		op = actionOperation{sessionEpoch: permit.sessionEpoch, action: m.Action, key: m.Key, mods: append([]string(nil), m.Mods...), active: true, state: "pending", nextSequence: 2, receipts: make(map[uint64]actionReceipt), sequenceDone: map[uint64]chan struct{}{1: make(chan struct{})}, dispatchMu: &sync.Mutex{}}
		s.actionOps[m.OperationID] = op
	}
	s.mu.Unlock()

	// Reserve repeat sequences under s.mu above, but wait for the preceding
	// provider call before entering the lifecycle gate. This keeps a fast repeat
	// from overtaking a delayed press when websocket frames are handled by
	// separate goroutines.
	if phase == "repeat" {
		if ctx == nil {
			ctx = context.Background()
		}
		s.mu.Lock()
		op = s.actionOps[m.OperationID]
		previous := op.sequenceDone[m.ActionSequence-1]
		s.mu.Unlock()
		if previous != nil {
			select {
			case <-previous:
			case <-ctx.Done():
				return s.finishQueuedAction(m, phase, "dispatch_wait_interrupted", "uncertain")
			}
		}
		s.mu.Lock()
		op = s.actionOps[m.OperationID]
		cancelled := op.cancelled || !op.active
		s.mu.Unlock()
		if cancelled {
			return s.finishQueuedAction(m, phase, "operation_cancelled", "rejected")
		}
	}
	if !s.admitActionProvider(m.OperationID) {
		return s.finishQueuedAction(m, phase, "operation_cancelled", "rejected")
	}

	resultState, detail := s.executeKeyAction(ctx, permit, m)
	s.mu.Lock()
	op, operationPresent := s.actionOps[m.OperationID]
	if !operationPresent || op.sessionEpoch != permit.sessionEpoch {
		s.mu.Unlock()
		// The provider may have run before a reconnect retired this operation;
		// do not recreate it in the new session or make it replayable there.
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: resultState, Detail: "session_replaced", SessionEpoch: permit.sessionEpoch}
	}
	if op.cancelled {
		// Cancellation stops future sequences but cannot undo a provider call
		// already admitted. Preserve the terminal operation state while returning
		// the provider's actual result for this sequence.
		op.active = false
		switch resultState {
		case "executed":
			detail = "executed_after_cancel"
		case "admitted":
			detail = "admitted_after_cancel"
		case "uncertain":
			detail = "uncertain_after_cancel"
		}
	} else if resultState == "executed" || resultState == "admitted" {
		op.state = resultState
	} else {
		op.state = resultState
		op.active = false
	}
	s.actionOps[m.OperationID] = op
	repeatCount := op.repeatCount
	sequence := m.ActionSequence
	if sequence == 0 {
		sequence = 1
	}
	receipt := actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: resultState, RepeatCount: repeatCount, Detail: detail, SessionEpoch: permit.sessionEpoch}
	if op.receipts == nil {
		op.receipts = make(map[uint64]actionReceipt)
	}
	op.receipts[sequence] = receipt
	closeActionSequenceLocked(&op, sequence)
	s.actionOps[m.OperationID] = op
	s.mu.Unlock()
	return receipt
}

func (s *Server) admitActionProvider(operationID string) bool {
	s.mu.Lock()
	op, found := s.actionOps[operationID]
	dispatchMu := op.dispatchMu
	s.mu.Unlock()
	if !found || dispatchMu == nil {
		return false
	}
	dispatchMu.Lock()
	defer dispatchMu.Unlock()
	s.mu.Lock()
	op, found = s.actionOps[operationID]
	allowed := found && !op.cancelled && op.active
	s.mu.Unlock()
	return allowed
}

func (s *Server) finishQueuedAction(m Msg, phase, detail, state string) actionReceipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, found := s.actionOps[m.OperationID]
	if !found {
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "unknown_operation", SessionEpoch: m.SessionEpoch}
	}
	receipt := actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: state, RepeatCount: op.repeatCount, Detail: detail, SessionEpoch: op.sessionEpoch}
	if state != "executed" && state != "admitted" {
		op.active = false
		if !op.cancelled {
			op.state = state
		}
	}
	if op.receipts == nil {
		op.receipts = make(map[uint64]actionReceipt)
	}
	op.receipts[m.ActionSequence] = receipt
	closeActionSequenceLocked(&op, m.ActionSequence)
	s.actionOps[m.OperationID] = op
	return receipt
}

func closeActionSequenceLocked(op *actionOperation, sequence uint64) {
	if op.sequenceDone == nil {
		return
	}
	if done, ok := op.sequenceDone[sequence]; ok {
		close(done)
		delete(op.sequenceDone, sequence)
	}
}

func (s *Server) executeKeyAction(ctx context.Context, permit mutationPermit, m Msg) (string, string) {
	var result input.ActionResult
	err := s.runLifecycleMutation(permit, func() error {
		actionCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if executor, ok := s.inj.(input.ActionExecutor); ok {
			if m.Action == "special" {
				result = executor.SpecialAction(actionCtx, m.Key)
			} else {
				result = executor.ComboAction(actionCtx, m.Mods, m.Key)
			}
		} else {
			s.routeInjector(m)
			result = input.ActionResult{State: "admitted", Detail: "provider_execution_unobserved"}
		}
		return nil
	})
	if err != nil {
		return "rejected", "input_permission_changed"
	}
	if result.State != "executed" && result.State != "admitted" && result.State != "rejected" && result.State != "uncertain" {
		return "uncertain", "invalid_provider_receipt"
	}
	return result.State, result.Detail
}

func (s *Server) writeActionReceipt(ctx context.Context, c *websocket.Conn, receipt actionReceipt) {
	if c == nil {
		return
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return
	}
	s.capabilitySendMu.Lock()
	defer s.capabilitySendMu.Unlock()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		c.CloseNow()
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
