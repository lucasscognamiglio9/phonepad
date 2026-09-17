// Package input traduce las acciones del protocolo (SPEC §3) a eventos uinput
// (SPEC §4). La interfaz Injector aísla la lógica de ruteo/mapeo del hardware,
// así el server y los tests trabajan contra ella sin tocar /dev/uinput.
package input

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/bendahl/uinput"
)

// Injector recibe acciones de alto nivel ya clasificadas por el cliente y las
// inyecta al sistema. Los métodos no devuelven error a propósito: en LAN las
// inyecciones uinput no fallan de forma recuperable y propagar errores por
// cada evento complicaría el server sin beneficio. Un fallo de inyección se
// loguea internamente.
type Injector interface {
	Move(dx, dy int)              // EV_REL REL_X/REL_Y
	Button(btn string, down bool) // BTN_LEFT/RIGHT/MIDDLE
	Scroll(dx, dy int)            // REL_WHEEL / REL_HWHEEL
	Text(s string)                // texto Unicode (vía wtype / virtual keyboard)
	Special(key string)           // tecla especial (SPEC §3)
	Combo(mods []string, key string)
	Gesture(name string) // gesto discreto de 3 dedos → combo de teclas (SPEC §4)
	// Touch reenvía la foto de contactos vivos de un frame al touchpad de
	// precisión emulado; libinput clasifica los gestos nativamente (ADR 0005).
	// No-op si el device no tiene touchpad MT (camino absoluto / agente).
	Touch(contacts []Contact)
	Close()
}

// Resettable es implementado por injectores que mantienen estado físico.
// El server lo invoca al desconectar o reemplazar una sesión para no dejar
// botones, teclas o contactos MT "pegados". Se mantiene separado de Injector
// para que integraciones/test doubles antiguos sigan siendo válidos.
type Resettable interface {
	Reset()
}

// TouchCanceler is optional so older Injector implementations remain source
// compatible. A cancel is distinct from an empty touch snapshot: it tells the
// MT device to mark every active slot as MT_TOOL_PALM before releasing it,
// which prevents libinput from interpreting pointercancel as a tap.
type TouchCanceler interface {
	CancelTouch()
}

// ClipboardMu serializes the daemon's short-lived Unicode paste with the
// server's attachment clipboard provider. Both paths temporarily become the
// desktop clipboard owner; without one process-wide gate, an upload can race
// the Unicode path and leave either the prompt text or the attachment as the
// final selection. It does not read or retain clipboard contents itself.
var ClipboardMu sync.Mutex

// SerializedInjector expone el Injector junto con Reset. NewAsyncText devuelve
// esta interfaz para que el dueño del recurso pueda limpiar el estado al cortar
// una sesión sin hacer type assertions; sigue siendo asignable a Injector.
type SerializedInjector interface {
	Injector
	Resettable
	TouchCanceler
}

// AbsInjector es un Injector que además posiciona el cursor de forma ABSOLUTA.
// Lo usa el control por agente (computer use): las coordenadas vienen de una
// captura de pantalla, no de deltas relativos como en el touchpad del celular.
// El resto de los métodos (Button, Scroll, Text, Special, Combo) se comparten
// con el camino relativo sin cambios.
type AbsInjector interface {
	Injector
	// MoveTo ubica el cursor en (x,y), en el rango [0,w]x[0,h] declarado en
	// NewAbsolute. El compositor mapea ese rango al área física del display.
	MoveTo(x, y int)
}

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
	inner  Injector
	ch     chan asyncOp
	done   chan struct{}
	mu     sync.Mutex
	epoch  atomic.Uint64
	closed bool
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
	}
}

func (a *asyncText) submit(op asyncOp) bool {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return false
	}
	op.epoch = a.epoch.Load()
	// Serializar el envío bajo el mismo lock que Reset/Close garantiza que una
	// operación que ve la sesión vieja no pueda colarse detrás del barrier.
	if op.ctx != nil {
		select {
		case a.ch <- op:
		case <-op.ctx.Done():
			a.mu.Unlock()
			return false
		}
	} else {
		a.ch <- op
	}
	a.mu.Unlock()
	return true
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
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	epoch := a.epoch.Add(1)
	done := make(chan struct{})
	a.ch <- asyncOp{kind: opReset, epoch: epoch, done: done}
	a.mu.Unlock()
	<-done
}

func (a *asyncText) Close() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.closed = true
	// Close debe conservar la semántica anterior: drena los textos/acciones que
	// ya estaban encolados antes de cerrar, por eso no cambia epoch.
	done := make(chan struct{})
	a.ch <- asyncOp{kind: opClose, epoch: a.epoch.Load(), done: done}
	a.mu.Unlock()
	<-done
	close(a.ch)
	<-a.done
}

// uinputDevice es la implementación real sobre github.com/bendahl/uinput.
// Usa devices virtuales separados (mouse + keyboard, y un touchpad si es
// absoluto) porque la lib no expone un device combinado; para el compositor son
// periféricos distintos, indistinguible para el usuario.
type uinputDevice struct {
	mouse uinput.Mouse // != nil sólo en el camino absoluto (NewAbsolute)
	kbd   uinput.Keyboard
	pad   uinput.TouchPad // != nil sólo en el camino absoluto (NewAbsolute)
	mt    *mtTouchpad     // != nil sólo en el camino del celular (New)
	mu    sync.Mutex
	held  map[int]struct{} // teclas presionadas, para liberar en Reset/Close
	btns  map[string]bool  // botones del mouse actualmente abajo
}

// New crea los devices del camino del celular: un teclado virtual (para el
// actionbar) y un touchpad de precisión multitouch (ADR 0005). NO crea mouse
// REL: tap/click/click-derecho/scroll los sintetiza libinput desde los contactos
// del touchpad. Falla si no hay permiso sobre /dev/uinput (ver setup/setup.sh).
func New() (Injector, error) {
	kbd, err := uinput.CreateKeyboard("/dev/uinput", []byte("phonepad-keyboard"))
	if err != nil {
		return nil, fmt.Errorf("crear teclado virtual: %w", err)
	}
	mt, err := newMTTouchpad()
	if err != nil {
		kbd.Close()
		return nil, err
	}
	mouse, err := uinput.CreateMouse("/dev/uinput", []byte("phonepad-mouse"))
	if err != nil {
		mt.close()
		kbd.Close()
		return nil, err
	}
	return &uinputDevice{mouse: mouse, kbd: kbd, mt: mt, held: make(map[int]struct{}), btns: make(map[string]bool)}, nil
}

// NewAbsolute crea los devices para control absoluto (computer use): mouse (para
// scroll y clicks), teclado, y un touchpad EV_ABS cuyo rango [0,w]x[0,h] el
// compositor mapea al área física del display. Así MoveTo(x,y) ubica el cursor
// en el píxel (x,y) de una captura de wxh — sin factor de escala ni tracking de
// posición. Falla igual que New si no hay permiso sobre /dev/uinput.
func NewAbsolute(w, h int) (AbsInjector, error) {
	mouse, err := uinput.CreateMouse("/dev/uinput", []byte("phonepad-abs-mouse"))
	if err != nil {
		return nil, fmt.Errorf("crear mouse virtual: %w", err)
	}
	kbd, err := uinput.CreateKeyboard("/dev/uinput", []byte("phonepad-abs-keyboard"))
	if err != nil {
		mouse.Close()
		return nil, fmt.Errorf("crear teclado virtual: %w", err)
	}
	pad, err := uinput.CreateTouchPad("/dev/uinput", []byte("phonepad-abs-pad"), 0, int32(w), 0, int32(h))
	if err != nil {
		mouse.Close()
		kbd.Close()
		return nil, fmt.Errorf("crear touchpad virtual: %w", err)
	}
	return &uinputDevice{mouse: mouse, kbd: kbd, pad: pad, held: make(map[int]struct{}), btns: make(map[string]bool)}, nil
}

// MoveTo posiciona el cursor de forma absoluta. En un device relativo (New, sin
// touchpad) es un no-op: el posicionamiento absoluto sólo existe en NewAbsolute.
func (d *uinputDevice) MoveTo(x, y int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pad == nil {
		return
	}
	if err := d.pad.MoveTo(int32(x), int32(y)); err != nil {
		log.Printf("uinput move-to: %v", err)
	}
}

// Touch reenvía la foto de contactos al touchpad de precisión. No-op en el
// camino absoluto/agente (sin touchpad MT). Ver touchpad.go (mapeo) y ADR 0005.
func (d *uinputDevice) Touch(contacts []Contact) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mt == nil {
		return
	}
	d.mt.touch(contacts)
}

// CancelTouch is the explicit pointercancel path. The absolute injector has
// no MT slots, so its implementation is intentionally a no-op.
func (d *uinputDevice) CancelTouch() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mt != nil {
		d.mt.cancel()
	}
}

func (d *uinputDevice) Move(dx, dy int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mouse == nil {
		return // camino del celular: el movimiento llega por Touch, no por REL
	}
	// uinput.Move hace REL_X + REL_Y + SYN en una llamada. Acepta negativos.
	if err := d.mouse.Move(int32(dx), int32(dy)); err != nil {
		log.Printf("uinput move: %v", err)
	}
}

func (d *uinputDevice) Button(btn string, down bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mouse == nil {
		return
	}
	switch btn {
	case "l":
		var err error
		if down {
			err = d.mouse.LeftPress()
		} else {
			err = d.mouse.LeftRelease()
		}
		if err != nil {
			log.Printf("uinput left %s: %v", buttonAction(down), err)
			d.rememberButtonUncertain(btn)
		} else {
			if d.btns == nil {
				d.btns = make(map[string]bool)
			}
			d.btns[btn] = down
		}
	case "r":
		var err error
		if down {
			err = d.mouse.RightPress()
		} else {
			err = d.mouse.RightRelease()
		}
		if err != nil {
			log.Printf("uinput right %s: %v", buttonAction(down), err)
			d.rememberButtonUncertain(btn)
		} else {
			if d.btns == nil {
				d.btns = make(map[string]bool)
			}
			d.btns[btn] = down
		}
	case "m":
		var err error
		if down {
			err = d.mouse.MiddlePress()
		} else {
			err = d.mouse.MiddleRelease()
		}
		if err != nil {
			log.Printf("uinput middle %s: %v", buttonAction(down), err)
			d.rememberButtonUncertain(btn)
		} else {
			if d.btns == nil {
				d.btns = make(map[string]bool)
			}
			d.btns[btn] = down
		}
	}
}

// rememberButtonUncertain treats any vendor error as an uncertain physical
// state. bendahl/uinput writes the button event and SYN_REPORT separately, so
// an error may arrive after the button event was accepted. A conservative
// held marker makes Reset retry the release; an extra release is harmless,
// while forgetting the marker could leave a button pressed indefinitely.
func (d *uinputDevice) rememberButtonUncertain(btn string) {
	if d.btns == nil {
		d.btns = make(map[string]bool)
	}
	d.btns[btn] = true
}

func buttonAction(down bool) string {
	if down {
		return "down"
	}
	return "up"
}

func (d *uinputDevice) Scroll(dx, dy int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mouse == nil {
		return
	}
	// Wheel(horizontal, delta): vertical primero, luego horizontal si hace falta.
	if dy != 0 {
		if err := d.mouse.Wheel(false, int32(dy)); err != nil {
			log.Printf("uinput vertical scroll: %v", err)
		}
	}
	if dx != 0 {
		if err := d.mouse.Wheel(true, int32(dx)); err != nil {
			log.Printf("uinput horizontal scroll: %v", err)
		}
	}
}

// Text inyecta texto Unicode (acentos, ñ, emoji). uinput emite scancodes, no
// codepoints, y GNOME Mutter NO implementa zwp_virtual_keyboard_v1 (por eso
// wtype falla con "Compositor does not support the virtual keyboard protocol").
// Estrategia híbrida (SPEC §4): el ASCII del layout US se emite por keycode
// directo (rápido, sin tocar el clipboard); las runes Unicode se pegan por
// portapapeles, único camino que entrega el codepoint exacto en GNOME Wayland.
// planText (testeado) decide el reparto; acá solo ejecutamos.
func (d *uinputDevice) Text(s string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, op := range planText(s) {
		if op.paste != "" {
			d.pasteUnicode(op.paste)
			continue
		}
		if op.shift {
			d.keyDown(uinput.KeyLeftshift)
		}
		d.keyPress(op.code)
		if op.shift {
			d.keyUp(uinput.KeyLeftshift)
		}
	}
}

// pasteUnicode inyecta un fragmento Unicode vía portapapeles: guarda el clip
// actual, copia el fragmento, emite Ctrl+V por uinput y restaura el clip. Es el
// camino Unicode-safe en GNOME Wayland. Límite conocido: las terminales VTE
// (GNOME Terminal) pegan con Ctrl+Shift+V, así que ahí el fragmento no aparece;
// el ASCII (la mayoría del texto y de los comandos) sí, porque va por keycode.
func (d *uinputDevice) pasteUnicode(frag string) {
	ClipboardMu.Lock()
	defer ClipboardMu.Unlock()
	// Snapshot one useful offered MIME before the temporary Unicode paste. A
	// plain wl-paste read would turn a PNG/file URI selection into untyped
	// bytes, so restoring it later would make image/document paste targets stop
	// recognizing the attachment. Empty clipboard and unavailable wl-clipboard
	// are both ordinary no-op cases here.
	saved, haveSaved := snapshotClipboard()
	cp := exec.Command("wl-copy")
	cp.Stdin = strings.NewReader(frag)
	if err := runClipboardCommand(cp); err != nil {
		log.Printf("wl-copy: %v (¿está instalado wl-clipboard?)", err)
		return
	}
	d.keyDown(uinput.KeyLeftctrl)
	d.keyPress(uinput.KeyV)
	d.keyUp(uinput.KeyLeftctrl)
	// Dar tiempo a la app a consumir el paste antes de restaurar el clip.
	time.Sleep(40 * time.Millisecond)
	if haveSaved {
		rp := exec.Command("wl-copy", "--type", saved.mime)
		rp.Stdin = bytes.NewReader(saved.data)
		if err := runClipboardCommand(rp); err != nil {
			log.Printf("restaurar clipboard: %v", err)
		}
	}
}

const (
	maxClipboardSnapshotBytes = 128 << 20
	clipboardCommandTimeout   = 2 * time.Second
)

type clipboardSnapshot struct {
	mime string
	data []byte
}

// snapshotClipboard captures only the format we can restore faithfully with
// wl-copy. The format list is metadata; no clipboard data is retained unless
// one of these known MIME types is offered. The size cap keeps restoring an
// unexpectedly large selection bounded.
func snapshotClipboard() (clipboardSnapshot, bool) {
	types, err := commandOutputLimited(exec.Command("wl-paste", "--list-types"), 64<<10)
	if err != nil {
		return clipboardSnapshot{}, false
	}
	var candidates []string
	for _, line := range strings.Split(string(types), "\n") {
		mime := strings.TrimSpace(line)
		if mime == "" || clipboardMimeRank(mime) < 0 {
			continue
		}
		candidates = append(candidates, mime)
	}
	// wl-paste does not promise an ordering. Prefer image data, then URI
	// formats, then plain text so a file selection remains a file selection.
	sort.SliceStable(candidates, func(i, j int) bool {
		return clipboardMimeRank(candidates[i]) < clipboardMimeRank(candidates[j])
	})
	for _, mime := range candidates {
		data, err := commandOutputLimited(exec.Command("wl-paste", "--type", mime, "--no-newline"), maxClipboardSnapshotBytes)
		if err == nil {
			return clipboardSnapshot{mime: mime, data: data}, true
		}
	}
	return clipboardSnapshot{}, false
}

func clipboardMimeRank(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/png":
		return 0
	case "image/jpeg", "image/jpg":
		return 1
	case "image/gif", "image/webp":
		return 2
	case "text/uri-list":
		return 10
	case "x-special/gnome-copied-files":
		return 11
	case "application/x-kde4-urilist":
		return 12
	case "text/plain;charset=utf-8":
		return 20
	case "text/plain":
		return 21
	default:
		return -1
	}
}

func commandOutputLimited(command *exec.Cmd, limit int64) ([]byte, error) {
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	type outputResult struct {
		data []byte
		err  error
	}
	readDone := make(chan outputResult, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(stdout, limit+1))
		readDone <- outputResult{data: data, err: err}
	}()
	var result outputResult
	timer := time.NewTimer(clipboardCommandTimeout)
	select {
	case result = <-readDone:
		timer.Stop()
	case <-timer.C:
		_ = command.Process.Kill()
		result = <-readDone
		_ = command.Wait()
		return nil, fmt.Errorf("clipboard read timed out")
	}
	data, readErr := result.data, result.err
	if int64(len(data)) > limit {
		// Stop an over-sized producer before Wait; otherwise it can remain
		// blocked writing into the full pipe while we wait for its exit.
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, fmt.Errorf("clipboard output exceeds %d bytes", limit)
	}
	if readErr != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, readErr
	}
	waitErr := command.Wait()
	if waitErr != nil {
		return nil, waitErr
	}
	return data, nil
}

// runClipboardCommand bounds both the temporary Unicode copy and the MIME
// restore. A clipboard owner can disappear or stop servicing requests; the
// input worker must then continue processing keyboard events promptly.
func runClipboardCommand(command *exec.Cmd) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardCommandTimeout)
	defer cancel()
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		<-done
		return ctx.Err()
	}
}

// textOp es un paso del tipeo de un string: o una pulsación por keycode
// (con/ sin Shift), o un paste de un fragmento Unicode vía portapapeles.
type textOp struct {
	paste string // != "" → pegar este fragmento (camino Unicode)
	code  int    // camino keycode
	shift bool
}

// planText descompone s en la secuencia de operaciones para tipearlo: el ASCII
// del layout US va por keycode (runeToKey); las runes que no resuelve se pegan
// por portapapeles (único camino Unicode-safe en GNOME Wayland sin el protocolo
// virtual-keyboard). Las runes no-ASCII contiguas se agrupan en un solo paste
// para minimizar el clobber del clipboard.
func planText(s string) []textOp {
	var ops []textOp
	var buf []rune // acumula no-ASCII contiguos
	flush := func() {
		if len(buf) > 0 {
			ops = append(ops, textOp{paste: string(buf)})
			buf = buf[:0]
		}
	}
	for _, r := range s {
		if code, shift, ok := runeToKey(r); ok {
			flush()
			ops = append(ops, textOp{code: code, shift: shift})
		} else {
			buf = append(buf, r)
		}
	}
	flush()
	return ops
}

func (d *uinputDevice) Special(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	code, ok := specialKeys[key]
	if !ok {
		return // tecla desconocida: se ignora (forward-compat)
	}
	d.keyPress(code)
}

func (d *uinputDevice) Combo(mods []string, key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.comboLocked(mods, key)
}

func (d *uinputDevice) comboLocked(mods []string, key string) {
	var held []int
	for _, m := range mods {
		if code, ok := modKeys[m]; ok {
			d.keyDown(code)
			held = append(held, code)
		}
	}
	// key puede ser una tecla especial (ej. "Tab" en Alt+Tab) o un solo char.
	pressed := false
	if code, ok := specialKeys[key]; ok {
		d.keyPress(code)
		pressed = true
	} else if r := []rune(key); len(r) == 1 {
		// En un combo emitimos solo el keycode base, sin el Shift que normalmente
		// agregaría una mayúscula: los mods del combo son los que manda el cliente.
		if code, _, ok := runeToKey(unicode.ToLower(r[0])); ok {
			d.keyPress(code)
			pressed = true
		}
	}
	// Key fuera del layout US (ej. Ctrl+é con un mod armado): no hay keycode que
	// emitir, así que el combo no hace nada. Dejamos rastro — si no, falla mudo.
	if !pressed {
		log.Printf("combo: tecla %q no resoluble (mods=%v); no se inyectó nada", key, mods)
	}
	// Release de mods en orden inverso.
	for i := len(held) - 1; i >= 0; i-- {
		d.keyUp(held[i])
	}
}

// Gesture traduce un gesto discreto de 3 dedos a una combinación de teclas y la
// inyecta reusando el camino de Combo (SPEC §4). El nombre desconocido se ignora
// (forward-compat). El mapeo vive acá, en la capa que conoce los keycodes.
func (d *uinputDevice) Gesture(name string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	g, ok := gestureCombos[name]
	if !ok {
		return // gesto desconocido: ignorar (forward-compat)
	}
	d.comboLocked(g.mods, g.key)
}

func (d *uinputDevice) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.resetLocked()
	if d.mouse != nil {
		if err := d.mouse.Close(); err != nil {
			log.Printf("uinput close mouse: %v", err)
		}
	}
	if d.kbd != nil {
		if err := d.kbd.Close(); err != nil {
			log.Printf("uinput close keyboard: %v", err)
		}
	}
	if d.pad != nil {
		if err := d.pad.Close(); err != nil {
			log.Printf("uinput close absolute pad: %v", err)
		}
	}
	if d.mt != nil {
		d.mt.close()
	}
}

// keyDown/keyUp mantienen el inventario de teclas que podrían quedar abajo si
// la conexión se corta entre el down y el up. Deben llamarse con d.mu tomado.
func (d *uinputDevice) keyDown(code int) {
	if d.kbd == nil {
		return
	}
	if err := d.kbd.KeyDown(code); err != nil {
		log.Printf("uinput key down %d: %v", code, err)
		d.rememberKeyUncertain(code)
		return
	}
	d.rememberKeyUncertain(code)
}

func (d *uinputDevice) keyUp(code int) {
	if d.kbd == nil {
		delete(d.held, code)
		return
	}
	if err := d.kbd.KeyUp(code); err != nil {
		log.Printf("uinput key up %d: %v", code, err)
		d.rememberKeyUncertain(code)
		return
	}
	delete(d.held, code)
}

func (d *uinputDevice) keyPress(code int) {
	if d.kbd == nil {
		return
	}
	if err := d.kbd.KeyPress(code); err != nil {
		log.Printf("uinput key press %d: %v", code, err)
		d.rememberKeyUncertain(code)
	}
}

// rememberKeyUncertain records a key whenever a vendor call cannot confirm
// the complete event sequence. KeyPress/KeyDown/KeyUp in bendahl/uinput each
// write one or more input_event records; an error can therefore mean that an
// earlier record was accepted. Reset will issue a compensating KeyUp.
func (d *uinputDevice) rememberKeyUncertain(code int) {
	if d.held == nil {
		d.held = make(map[int]struct{})
	}
	d.held[code] = struct{}{}
}

// Reset libera todo estado físico conocido. Es idempotente y seguro para los
// dos caminos (celular MT y computer-mcp absoluto).
func (d *uinputDevice) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.resetLocked()
}

func (d *uinputDevice) resetLocked() {
	if d.mt != nil {
		d.mt.reset()
	}
	if d.mouse != nil {
		if d.btns["l"] {
			if err := d.mouse.LeftRelease(); err != nil {
				log.Printf("uinput reset left: %v", err)
			} else {
				delete(d.btns, "l")
			}
		}
		if d.btns["r"] {
			if err := d.mouse.RightRelease(); err != nil {
				log.Printf("uinput reset right: %v", err)
			} else {
				delete(d.btns, "r")
			}
		}
		if d.btns["m"] {
			if err := d.mouse.MiddleRelease(); err != nil {
				log.Printf("uinput reset middle: %v", err)
			} else {
				delete(d.btns, "m")
			}
		}
	}
	for code := range d.held {
		d.keyUp(code)
	}
}

// LiteralText uses the same FIFO as key actions and pointer edges. A caller
// timing out cannot assume that an already started adapter had no effect.
func (a *asyncText) LiteralText(ctx context.Context, text, target string) LiteralResult {
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
