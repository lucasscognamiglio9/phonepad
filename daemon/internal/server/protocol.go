// Package server implementa el transporte (HTTP + WebSocket) y el parseo del
// protocolo JSON definido en SPEC.md §3.
package server

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"

	"phonepad/daemon/internal/input"
)

const (
	// maxFrameBytes is both the parser and websocket read limit. Frames are
	// intentionally tiny (a touch snapshot is <1KB); the cap avoids allocating
	// unbounded input on a LAN-facing endpoint.
	maxFrameBytes = 64 * 1024
	maxTextBytes  = 8 * 1024
	maxNameBytes  = 64
	maxContacts   = 5
	maxMods       = 4
	maxDelta      = 10000
	maxScroll     = 1000
)

// Msg es el sobre común: todos los mensajes traen el campo "t" (tipo).
// Los campos restantes se llenan según el tipo; un campo ausente queda en su
// cero. El consumidor decide qué campos son válidos según Type.
type Msg struct {
	Type string `json:"t"`

	// m / s: deltas de movimiento o scroll.
	Dx int `json:"dx"`
	Dy int `json:"dy"`

	// b: acción ("down"/"up") y botón ("l"/"r"/"m").
	Action string `json:"a"`
	Button string `json:"btn"`

	// k: subtipo va también en Action ("text"/"special"/"combo").
	Text string   `json:"text"`
	Key  string   `json:"key"`
	Mods []string `json:"mods"`

	// g: nombre del gesto discreto de 3 dedos ("overview"/"ws-left"/"ws-right").
	Name string `json:"name"`

	// t: foto de los contactos vivos del frame (touchpad de precisión, ADR 0005).
	// Coordenadas normalizadas 0..1; el daemon las mapea a slots MT Type B.
	Touches []input.Contact `json:"c"`
	// cancel marks the end of an interrupted touch sequence. It is only valid
	// with an explicitly empty contact snapshot; the input layer then reports
	// MT_TOOL_PALM before releasing the slots.
	Cancel bool `json:"cancel,omitempty"`
}

// Parse decodifica un text frame JSON a un Msg tipado.
// Devuelve ok=false ante JSON inválido o sin campo "t": el server debe
// ignorar el frame sin panic (forward-compat, SPEC §3 "mensajes desconocidos
// se ignoran silenciosamente"). Un "t" desconocido devuelve ok=true con el
// Type tal cual; el ruteo posterior lo descarta.
func Parse(data []byte) (Msg, bool) {
	if len(data) == 0 || len(data) > maxFrameBytes {
		return Msg{}, false
	}
	var m Msg
	if err := json.Unmarshal(data, &m); err != nil {
		return Msg{}, false
	}
	if m.Type == "" {
		return Msg{}, false
	}
	if m.Cancel && m.Type != "t" {
		return Msg{}, false
	}
	if m.Type == "t" {
		// `c:[]` es la transición explícita de lift-all. Omitir c o enviarlo
		// como null es un frame incompleto y no debe convertirse silenciosamente
		// en un reset de todos los dedos.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return Msg{}, false
		}
		raw, present := fields["c"]
		if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return Msg{}, false
		}
	}
	if m.Type == "k" && m.Action == "combo" {
		for i, mod := range m.Mods {
			m.Mods[i] = strings.ToLower(mod)
		}
	}
	if !validMsg(m) {
		return Msg{}, false
	}
	return m, true
}

func validMsg(m Msg) bool {
	switch m.Type {
	case "m":
		return absBound(m.Dx, maxDelta) && absBound(m.Dy, maxDelta)
	case "b":
		return (m.Action == "down" || m.Action == "up") && (m.Button == "l" || m.Button == "r" || m.Button == "m")
	case "s":
		return absBound(m.Dx, maxScroll) && absBound(m.Dy, maxScroll)
	case "k":
		if m.Action != "text" && m.Action != "special" && m.Action != "combo" {
			return false
		}
		if !utf8.ValidString(m.Text) || !utf8.ValidString(m.Key) || len(m.Text) > maxTextBytes || len(m.Key) > maxNameBytes {
			return false
		}
		if m.Action == "text" {
			return true // no-op válido; la PWA normalmente no lo emite
		}
		if m.Action == "special" {
			return validSpecial(m.Key)
		}
		if len(m.Mods) > maxMods || len(m.Key) == 0 || !validComboKey(m.Key) {
			return false
		}
		seen := make(map[string]struct{}, len(m.Mods))
		for _, mod := range m.Mods {
			if !validMod(mod) {
				return false
			}
			if _, ok := seen[mod]; ok {
				return false
			}
			seen[mod] = struct{}{}
		}
		return true
	case "g":
		if !utf8.ValidString(m.Name) || len(m.Name) == 0 || len(m.Name) > maxNameBytes {
			return false
		}
		switch m.Name {
		case "overview", "apps", "ws-left", "ws-right", "zoom-in", "zoom-out":
			return true
		default:
			return false
		}
	case "t":
		if m.Cancel && len(m.Touches) != 0 {
			return false
		}
		if len(m.Touches) > maxContacts {
			return false
		}
		seen := make(map[int]struct{}, len(m.Touches))
		for _, c := range m.Touches {
			if c.ID < 0 || c.ID > 1<<30 || math.IsNaN(c.X) || math.IsNaN(c.Y) || math.IsInf(c.X, 0) || math.IsInf(c.Y, 0) || c.X < 0 || c.X > 1 || c.Y < 0 || c.Y > 1 {
				return false
			}
			if _, ok := seen[c.ID]; ok {
				return false
			}
			seen[c.ID] = struct{}{}
		}
		return true
	case "ping":
		return true
	default:
		// Tipos futuros se aceptan (y se ignoran en el ruteo), pero no dejamos
		// campos gigantes sin límites porque el frame ya está acotado arriba.
		return true
	}
}

func absBound(v, max int) bool { return v >= -max && v <= max }

func validSpecial(k string) bool {
	switch k {
	case "Backspace", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown", "Super":
		return true
	default:
		return false
	}
}

func validMod(m string) bool {
	switch strings.ToLower(m) {
	case "ctrl", "alt", "super", "shift":
		return true
	default:
		return false
	}
}

func validComboKey(k string) bool {
	if validSpecial(k) {
		return true
	}
	return utf8.RuneCountInString(k) == 1
}

// Respuestas server → cliente (SPEC §3). Se serializan una sola vez como
// constantes para evitar reencodear en cada frame.
//
// Nota: el frame de error {"t":"err"} del §3 no se usa porque la validación de
// token ocurre en el handshake HTTP (401 antes del upgrade), no como frame WS;
// no hay otro punto donde el server rechace un mensaje, así que no hace falta.
var (
	respOK   = []byte(`{"t":"ok"}`)
	respPong = []byte(`{"t":"pong"}`)
	// respReload lo emite SOLO el modo dev (PushReload) cuando cambia un archivo
	// de web/: la PWA lo recibe y hace location.reload(). Prod nunca lo manda.
	respReload = []byte(`{"t":"reload"}`)
)
