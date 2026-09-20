package input

import (
	"context"
	"sync"
	"sync/atomic"
)

// asyncText decora un Injector para sacar el camino lento de texto del read loop
// del server. Text() en el camino real forkea wl-copy + emite Ctrl+V + duerme
// ~40ms (SPEC §4); hacerlo síncrono bloquea el read loop y late el cursor
// mientras se escribe/dicta. Un ÚNICO worker procesa una FIFO de todas las
// acciones, preservando la secuencia entre texto, teclas y contactos MT.
type asyncOp struct {
	kind    byte
	text    string
	btn     string
	down    bool
	dx      int
	dy      int
	key     string
	mods    []string
	name    string
	touch   []Contact
	epoch   uint64
	done    chan struct{}
	ctx     context.Context
	literal chan LiteralResult
	target  string
}

const (
	opMove byte = iota
	opButton
	opScroll
	opText
	opSpecial
	opCombo
	opGesture
	opTouch
	opTouchCancel
	opReset
	opClose
	opLiteral
	opLiteralFocus
)

// asyncText es un serializador de todas las operaciones del Injector. El nombre
// histórico se conserva por compatibilidad con NewAsyncText, pero ya no solo
// encola texto: Text/Special/Combo/Touch (y las demás acciones) pasan por una
// FIFO única, de modo que un paste lento no puede ser adelantado por una tecla
// especial ni por un frame MT posterior.
type asyncText struct {
	inner        Injector
	ch           chan asyncOp
	done         chan struct{}
	mu           sync.Mutex
	enqueueMu    sync.Mutex
	senders      sync.WaitGroup
	epoch        atomic.Uint64
	closed       bool
	closeDone    chan struct{}
	resetBarrier chan struct{}
}

// NewAsyncText envuelve inner en una FIFO. buf es el tamaño de la cola
// (holgado: el tipeo humano y los frames LAN normales no la llenan); las
// llamadas vuelven enseguida salvo que haya una ráfaga que llene el buffer.
// Close() drena la cola, espera al worker y recién entonces cierra el inner.
func NewAsyncText(inner Injector, buf int) SerializedInjector {
	if buf < 1 {
		buf = 1
	}
	a := &asyncText{inner: inner, ch: make(chan asyncOp, buf), done: make(chan struct{})}
	go a.loop()
	return a
}

func (a *asyncText) loop() {
	defer close(a.done)
	for op := range a.ch {
		current := a.epoch.Load()
		// Reset invalida todo lo que estaba pendiente en la FIFO. Una operación
		// que ya había empezado antes del reset termina y luego el barrier reset
		// deja el device en estado neutro.
		if op.epoch != current && op.kind != opReset && op.kind != opClose {
			if op.literal != nil {
				op.literal <- LiteralResult{State: "rejected", Detail: "input_context_cancelled"}
			}
			if op.done != nil {
				close(op.done)
			}
			continue
		}
		switch op.kind {
		case opMove:
			a.inner.Move(op.dx, op.dy)
		case opButton:
			a.inner.Button(op.btn, op.down)
		case opScroll:
			a.inner.Scroll(op.dx, op.dy)
		case opLiteral, opLiteralFocus:
			result := LiteralResult{State: "rejected", Detail: "literal_adapter_unavailable"}
			if op.ctx.Err() != nil {
				result = LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
			} else if adapter, ok := a.inner.(LiteralInjector); ok {
				if op.kind == opLiteralFocus {
					result = adapter.LiteralFocus(op.ctx)
				} else {
					result = adapter.LiteralText(op.ctx, op.text, op.target)
				}
			}
			op.literal <- result
		case opText:
			a.inner.Text(op.text)
		case opSpecial:
			a.inner.Special(op.key)
		case opCombo:
			a.inner.Combo(op.mods, op.key)
		case opGesture:
			a.inner.Gesture(op.name)
		case opTouch:
			a.inner.Touch(op.touch)
		case opTouchCancel:
			if canceler, ok := a.inner.(TouchCanceler); ok {
				canceler.CancelTouch()
			} else {
				// Keep compatibility with simple Injector test doubles and
				// legacy devices that only understand touch snapshots.
				a.inner.Touch(nil)
			}
		case opReset:
			if r, ok := a.inner.(Resettable); ok {
				r.Reset()
			}
		case opClose:
			a.inner.Close()
		}
		if op.done != nil {
			close(op.done)
		}
		if op.kind == opReset && op.done != nil {
			// Keep the barrier visible until after done is closed. A submitter
			// from the new epoch may wake here, but it must observe the cleared
			// barrier only after Reset has run on the worker.
			a.mu.Lock()
			if a.resetBarrier == op.done {
				a.resetBarrier = nil
			}
			a.mu.Unlock()
		}
	}
}

func (a *asyncText) submit(op asyncOp) bool {
	for {
		a.enqueueMu.Lock()
		a.mu.Lock()
		if a.closed {
			a.mu.Unlock()
			a.enqueueMu.Unlock()
			return false
		}
		if barrier := a.resetBarrier; barrier != nil {
			a.mu.Unlock()
			a.enqueueMu.Unlock()
			if op.ctx != nil {
				select {
				case <-barrier:
				case <-op.ctx.Done():
					return false
				}
			} else {
				<-barrier
			}
			continue
		}
		op.epoch = a.epoch.Load()
		// Do not hold a.mu while waiting for a full FIFO. CloseContext must be
		// able to mark the queue closed even when the worker is stuck in a
		// provider. The sender count keeps the channel alive until this send has
		// completed.
		a.senders.Add(1)
		a.mu.Unlock()
		defer func() {
			a.senders.Done()
			a.enqueueMu.Unlock()
		}()
		if op.ctx != nil {
			select {
			case a.ch <- op:
			case <-op.ctx.Done():
				return false
			}
		} else {
			a.ch <- op
		}
		return true
	}
}

func (a *asyncText) Move(dx, dy int) { a.submit(asyncOp{kind: opMove, dx: dx, dy: dy}) }
func (a *asyncText) Button(btn string, down bool) {
	a.submit(asyncOp{kind: opButton, btn: btn, down: down})
}
func (a *asyncText) Scroll(dx, dy int)  { a.submit(asyncOp{kind: opScroll, dx: dx, dy: dy}) }
func (a *asyncText) Text(s string)      { a.submit(asyncOp{kind: opText, text: s}) }
func (a *asyncText) Special(key string) { a.submit(asyncOp{kind: opSpecial, key: key}) }
func (a *asyncText) Combo(mods []string, key string) {
	a.submit(asyncOp{kind: opCombo, mods: append([]string(nil), mods...), key: key})
}
func (a *asyncText) Gesture(name string) { a.submit(asyncOp{kind: opGesture, name: name}) }
func (a *asyncText) Touch(contacts []Contact) {
	a.submit(asyncOp{kind: opTouch, touch: append([]Contact(nil), contacts...)})
}

// CancelTouch is queued in the same FIFO as touch frames, so a cancellation
// cannot overtake a preceding movement or touch-down frame.
func (a *asyncText) CancelTouch() { a.submit(asyncOp{kind: opTouchCancel}) }

// Reset invalida operaciones pendientes y espera a que el worker aplique el
// reset físico. El barrier queda en la FIFO luego de todas las operaciones que
// ya estaban en curso; las pendientes se descartan por epoch.
func (a *asyncText) Reset() {
	_ = a.ResetContext(context.Background())
}

func (a *asyncText) Close() {
	a.close(false, context.Background())
}

// ResetContext is the bounded form used by lifecycle teardown. If the caller
// times out, the reset barrier remains in the FIFO and the worker will still
// apply it; the caller must therefore not claim that cleanup finished.
func (a *asyncText) ResetContext(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		a.mu.Lock()
		if a.closed {
			a.mu.Unlock()
			return nil
		}
		if barrier := a.resetBarrier; barrier != nil {
			a.mu.Unlock()
			select {
			case <-barrier:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		// Publish the barrier under the short state lock. Do not acquire
		// enqueueMu here: an older sender may hold it while the FIFO is full.
		// That sender already has the old epoch and will be discarded; all new
		// senders wait for this barrier before they can enter the FIFO.
		epoch := a.epoch.Add(1)
		done := make(chan struct{})
		a.resetBarrier = done
		op := asyncOp{kind: opReset, epoch: epoch, done: done}
		a.senders.Add(1)
		a.mu.Unlock()
		go func() {
			defer a.senders.Done()
			a.enqueueMu.Lock()
			a.ch <- op
			a.enqueueMu.Unlock()
		}()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// CloseContext invalidates queued work and starts a background finalizer. The
// finalizer is deliberately independent of the caller's deadline: a provider
// can ignore context, but it must not keep the server mutex or the shutdown
// coordinator blocked forever. Repeated calls observe the same closeDone.
func (a *asyncText) CloseContext(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	var done chan struct{}
	a.mu.Lock()
	if !a.closed {
		a.closed = true
		a.epoch.Add(1) // drop all queued pre-shutdown input
		a.closeDone = make(chan struct{})
		go a.finishClose(a.closeDone)
	}
	done = a.closeDone
	a.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// close keeps the historical drain-before-close behavior for ordinary owner
// shutdown. CloseContext is the lifecycle path and passes invalidate=true.
func (a *asyncText) close(invalidate bool, ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	var done chan struct{}
	a.mu.Lock()
	if !a.closed {
		a.closed = true
		if invalidate {
			a.epoch.Add(1)
		}
		a.closeDone = make(chan struct{})
		done = a.closeDone
		a.mu.Unlock()
		go a.finishClose(done)
	} else {
		done = a.closeDone
		a.mu.Unlock()
		if done == nil {
			return
		}
		<-done
		return
	}
	<-done
}

func (a *asyncText) finishClose(done chan struct{}) {
	// No caller can submit after closed=true. Sending outside a.mu avoids
	// retaining that mutex while a full FIFO waits for the worker/provider.
	// Existing senders are allowed to finish before the channel is closed.
	a.senders.Wait()
	opDone := make(chan struct{})
	a.ch <- asyncOp{kind: opClose, epoch: a.epoch.Load(), done: opDone}
	// The op's completion is the only point at which inner.Close has returned.
	// Keep it separate from closeDone so a caller cannot observe the channel as
	// closed before the worker has released the underlying resource.
	<-opDone
	close(a.ch)
	<-a.done
	close(done)
}

// LiteralText uses the same FIFO as key actions and pointer edges. A caller
// timing out cannot assume that an already started adapter had no effect.
func (a *asyncText) LiteralText(ctx context.Context, text, target string) LiteralResult {
	if ctx == nil {
		ctx = context.Background()
	}
	result := make(chan LiteralResult, 1)
	if !a.submit(asyncOp{kind: opLiteral, text: text, target: target, ctx: ctx, literal: result}) {
		return LiteralResult{State: "rejected", Detail: "injector_closed"}
	}
	select {
	case receipt := <-result:
		return receipt
	case <-ctx.Done():
		return LiteralResult{State: "uncertain", Detail: "dispatch_wait_interrupted"}
	}
}

func (a *asyncText) LiteralFocus(ctx context.Context) LiteralResult {
	if ctx == nil {
		ctx = context.Background()
	}
	result := make(chan LiteralResult, 1)
	if !a.submit(asyncOp{kind: opLiteralFocus, ctx: ctx, literal: result}) {
		return LiteralResult{State: "rejected", Detail: "injector_closed"}
	}
	select {
	case receipt := <-result:
		return receipt
	case <-ctx.Done():
		return LiteralResult{State: "rejected", Detail: "focus_probe_interrupted"}
	}
}
