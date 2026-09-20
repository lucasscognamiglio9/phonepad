package input

import (
	"context"
	"errors"
	"sync"
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

// ContextResetter is an optional cancellation-aware reset hook. Implementations
// may return when ctx expires while finishing their physical cleanup in a
// worker; callers must then treat any in-flight input as uncertain.
type ContextResetter interface {
	ResetContext(context.Context) error
}

// ContextCloser is the shutdown counterpart of ContextResetter. It lets the
// daemon bound shutdown without changing the long-standing Injector.Close API.
type ContextCloser interface {
	CloseContext(context.Context) error
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

// Contact es un dedo en contacto con el pad, en coordenadas normalizadas 0..1
// (SPEC §3, ADR 0005). El cliente reenvía contactos crudos por frame; el daemon
// los mapea a slots del protocolo multitouch Type B y deja que libinput
// clasifique los gestos nativamente.
type Contact struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

// LiteralResult never claims to observe the destination application. Rejected
// means no edit was attempted; an interrupted/failed edit is uncertain.
type LiteralResult struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
	Target string `json:"target,omitempty"`
}

type LiteralInjector interface {
	LiteralText(context.Context, string, string) LiteralResult
	LiteralFocus(context.Context) LiteralResult
}

// ErrProviderUnavailable reports that this build has no native input provider.
// Linux builds may still return a device-specific setup error from New or
// NewAbsolute; non-Linux builds return this sentinel without a Demo fallback.
var ErrProviderUnavailable = errors.New("input provider unavailable on this platform")
