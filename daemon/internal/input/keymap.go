package input

import "github.com/bendahl/uinput"

// specialKeys mapea los nombres del protocolo (SPEC §3) a constantes KEY_* de
// la lib. Son exactamente las teclas especiales que el cliente puede mandar.
var specialKeys = map[string]int{
	"Backspace":  uinput.KeyBackspace,
	"Enter":      uinput.KeyEnter,
	"Tab":        uinput.KeyTab,
	"Escape":     uinput.KeyEsc,
	"ArrowUp":    uinput.KeyUp,
	"ArrowDown":  uinput.KeyDown,
	"ArrowLeft":  uinput.KeyLeft,
	"ArrowRight": uinput.KeyRight,
	"Delete":     uinput.KeyDelete,
	"Home":       uinput.KeyHome,
	"End":        uinput.KeyEnd,
	"PageUp":     uinput.KeyPageup,
	"PageDown":   uinput.KeyPagedown,
	// Super (Meta/Win): habilita el gesto "overview" vía Combo(nil,"Super"),
	// que hace un tap de la tecla y abre Activities en GNOME.
	"Super": uinput.KeyLeftmeta,
}

// gestureCombos mapea cada gesto discreto de 3 dedos (SPEC §4) a la combinación
// de teclas que lo espeja en GNOME. El cliente manda la intención; este es el
// único lugar donde vive la traducción a teclas (se reconfigura sin tocar la PWA).
//
// Nota GNOME: el atajo de workspace por defecto en GNOME 40+ es Super+PageUp/
// PageDown; Ctrl+Alt+Left/Right es el clásico y sigue activo en muchas configs.
// Si no anda contra la config real, cambiar acá una sola línea.
var gestureCombos = map[string]struct {
	mods []string
	key  string
}{
	"overview": {nil, "Super"},
	"apps":     {[]string{"super"}, "a"}, // Super+A: grilla de aplicaciones de GNOME
	"ws-left":  {[]string{"ctrl", "alt"}, "ArrowLeft"},
	"ws-right": {[]string{"ctrl", "alt"}, "ArrowRight"},
	// Legacy compatibility only: older clients classified pinch as magnifier
	// steps. The current PWA sends raw Touch frames, so libinput delivers pinch
	// to the active application like a physical touchpad.
	"zoom-in":  {[]string{"alt", "super"}, "="},
	"zoom-out": {[]string{"alt", "super"}, "-"},
}

// modKeys mapea los modificadores sticky del protocolo a sus keycodes.
// super = tecla Meta/Win (KeyLeftmeta).
var modKeys = map[string]int{
	"ctrl":  uinput.KeyLeftctrl,
	"alt":   uinput.KeyLeftalt,
	"super": uinput.KeyLeftmeta,
	"shift": uinput.KeyLeftshift,
}

// runeToKey traduce una rune a (keycode, needShift, ok) asumiendo layout US.
// Es el corazón del límite Unicode documentado en emitRune: solo conoce el
// ASCII imprimible del layout US. Cualquier otra rune devuelve ok=false.
func runeToKey(r rune) (code int, shift bool, ok bool) {
	if c, found := asciiNoShift[r]; found {
		return c, false, true
	}
	if c, found := asciiShift[r]; found {
		return c, true, true
	}
	return 0, false, false
}

// asciiNoShift: caracteres que en layout US se tipean sin Shift.
var asciiNoShift = map[rune]int{
	'a': uinput.KeyA, 'b': uinput.KeyB, 'c': uinput.KeyC, 'd': uinput.KeyD,
	'e': uinput.KeyE, 'f': uinput.KeyF, 'g': uinput.KeyG, 'h': uinput.KeyH,
	'i': uinput.KeyI, 'j': uinput.KeyJ, 'k': uinput.KeyK, 'l': uinput.KeyL,
	'm': uinput.KeyM, 'n': uinput.KeyN, 'o': uinput.KeyO, 'p': uinput.KeyP,
	'q': uinput.KeyQ, 'r': uinput.KeyR, 's': uinput.KeyS, 't': uinput.KeyT,
	'u': uinput.KeyU, 'v': uinput.KeyV, 'w': uinput.KeyW, 'x': uinput.KeyX,
	'y': uinput.KeyY, 'z': uinput.KeyZ,

	'0': uinput.Key0, '1': uinput.Key1, '2': uinput.Key2, '3': uinput.Key3,
	'4': uinput.Key4, '5': uinput.Key5, '6': uinput.Key6, '7': uinput.Key7,
	'8': uinput.Key8, '9': uinput.Key9,

	' ':  uinput.KeySpace,
	'\n': uinput.KeyEnter,
	'\t': uinput.KeyTab,

	'-':  uinput.KeyMinus,
	'=':  uinput.KeyEqual,
	'[':  uinput.KeyLeftbrace,
	']':  uinput.KeyRightbrace,
	'\\': uinput.KeyBackslash,
	';':  uinput.KeySemicolon,
	'\'': uinput.KeyApostrophe,
	'`':  uinput.KeyGrave,
	',':  uinput.KeyComma,
	'.':  uinput.KeyDot,
	'/':  uinput.KeySlash,
}

// asciiShift: caracteres que en layout US requieren Shift. Las mayúsculas se
// derivan de las minúsculas + Shift; acá van los símbolos shifteados.
var asciiShift = map[rune]int{
	'A': uinput.KeyA, 'B': uinput.KeyB, 'C': uinput.KeyC, 'D': uinput.KeyD,
	'E': uinput.KeyE, 'F': uinput.KeyF, 'G': uinput.KeyG, 'H': uinput.KeyH,
	'I': uinput.KeyI, 'J': uinput.KeyJ, 'K': uinput.KeyK, 'L': uinput.KeyL,
	'M': uinput.KeyM, 'N': uinput.KeyN, 'O': uinput.KeyO, 'P': uinput.KeyP,
	'Q': uinput.KeyQ, 'R': uinput.KeyR, 'S': uinput.KeyS, 'T': uinput.KeyT,
	'U': uinput.KeyU, 'V': uinput.KeyV, 'W': uinput.KeyW, 'X': uinput.KeyX,
	'Y': uinput.KeyY, 'Z': uinput.KeyZ,

	'!': uinput.Key1, '@': uinput.Key2, '#': uinput.Key3, '$': uinput.Key4,
	'%': uinput.Key5, '^': uinput.Key6, '&': uinput.Key7, '*': uinput.Key8,
	'(': uinput.Key9, ')': uinput.Key0,

	'_': uinput.KeyMinus,
	'+': uinput.KeyEqual,
	'{': uinput.KeyLeftbrace,
	'}': uinput.KeyRightbrace,
	'|': uinput.KeyBackslash,
	':': uinput.KeySemicolon,
	'"': uinput.KeyApostrophe,
	'~': uinput.KeyGrave,
	'<': uinput.KeyComma,
	'>': uinput.KeyDot,
	'?': uinput.KeySlash,
}
