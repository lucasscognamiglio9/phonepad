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

// PointerGeometry describes the physical mapper that an injector has already
// applied to its touch device. It is deliberately optional: legacy providers
// and non-touch injectors must not advertise a geometry they cannot prove.
// GeometryEpoch changes only when the mapper/device profile changes; clients
// cancel active contacts before accepting a new epoch.
type PointerGeometry struct {
	ID                string  `json:"id"`
	Kind              string  `json:"kind"`
	WidthMM           float64 `json:"widthMm,omitempty"`
	HeightMM          float64 `json:"heightMm,omitempty"`
	SideMM            float64 `json:"sideMm,omitempty"`
	GainMMPerPoint    float64 `json:"gainMmPerPoint,omitempty"`
	GainSource        string  `json:"gainSource,omitempty"`
	GainMinMMPerPoint float64 `json:"gainMinMmPerPoint,omitempty"`
	GainMaxMMPerPoint float64 `json:"gainMaxMmPerPoint,omitempty"`
	GeometryEpoch     uint64  `json:"geometryEpoch,omitempty"`
}

// PointerGeometryProvider lets the server expose the geometry actually
// configured on the native provider. A false result means that the provider
// cannot make a safe claim; the server then omits the optional extension.
type PointerGeometryProvider interface {
	PointerGeometry() (PointerGeometry, bool)
}

// PointerGeometryController applies a validated profile before the next
// contact sequence. Implementations must cancel active contacts and either
// leave the prior device/profile intact on error or return a terminal error.
type PointerGeometryController interface {
	PointerGeometryProvider
	ApplyPointerGeometry(context.Context, PointerGeometry) error
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
type DirectPointer interface {
	SupportsDirectPointer() bool
	MoveNormalized(x, y int) // normalized integer range 0..65535
}

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

// ActionResult reports the strongest result that the native provider can
// establish for one special key or combo. "executed" means the provider
// completed its call, "rejected" means it did not attempt the action, and
// "uncertain" means a provider error may have happened after part of the
// event reached the device. An Injector that does not implement
// ActionExecutor can still accept legacy actions, but the server must report
// those as admission only rather than pretending to observe the key.
type ActionResult struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
}

// ActionExecutor is optional for source compatibility with older providers.
// Calls run in the injector's serialized FIFO when the provider is wrapped by
// NewAsyncText. The context bounds waiting for the provider and must not be
// interpreted as proof that a started native call had no effect.
type ActionExecutor interface {
	SpecialAction(context.Context, string) ActionResult
	ComboAction(context.Context, []string, string) ActionResult
}

type LiteralInjector interface {
	LiteralText(context.Context, string, string) LiteralResult
	LiteralFocus(context.Context) LiteralResult
}

// ErrProviderUnavailable reports that this build has no native input provider.
// Linux builds may still return a device-specific setup error from New or
// NewAbsolute; non-Linux builds return this sentinel without a Demo fallback.
var ErrProviderUnavailable = errors.New("input provider unavailable on this platform")
