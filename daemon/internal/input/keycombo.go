package input

import "strings"

// ParseKeyCombo traduce un atajo como lo nombra un agente externo (computer use)
// — "ctrl+s", "Return", "alt+Tab", "super+a" — a (mods, key) listo para Combo.
// Los mods quedan en el vocabulario de modKeys y key en el de specialKeys o un
// carácter resoluble por runeToKey. ok=false si algún modificador o la tecla no
// se reconoce. Vive acá, junto al mapeo canónico de teclas (keymap.go), para que
// la nomenclatura del agente y los keycodes sean una única fuente de verdad.
func ParseKeyCombo(combo string) (mods []string, key string, ok bool) {
	parts := strings.Split(combo, "+")
	for _, m := range parts[:len(parts)-1] {
		cm := canonMod(m)
		if cm == "" {
			return nil, "", false
		}
		mods = append(mods, cm)
	}
	key = canonKey(parts[len(parts)-1])
	if key == "" {
		return nil, "", false
	}
	return mods, key, true
}

// canonMod normaliza el nombre de un modificador (con los alias que puede usar un
// agente) a su clave en modKeys. "" si no se reconoce.
func canonMod(m string) string {
	switch strings.ToLower(m) {
	case "ctrl", "control":
		return "ctrl"
	case "alt", "option":
		return "alt"
	case "shift":
		return "shift"
	case "super", "cmd", "win", "meta", "logo":
		return "super"
	}
	return ""
}

// canonKey normaliza el nombre de una tecla a una clave de specialKeys o, si es un
// único carácter, lo deja pasar sólo si runeToKey lo resuelve. "" si no se reconoce
// — así ParseKeyCombo nunca produce una key que Combo no sepa ejecutar.
func canonKey(k string) string {
	switch strings.ToLower(k) {
	case "return", "enter":
		return "Enter"
	case "escape", "esc":
		return "Escape"
	case "tab":
		return "Tab"
	case "backspace":
		return "Backspace"
	case "delete", "del":
		return "Delete"
	case "up", "arrowup":
		return "ArrowUp"
	case "down", "arrowdown":
		return "ArrowDown"
	case "left", "arrowleft":
		return "ArrowLeft"
	case "right", "arrowright":
		return "ArrowRight"
	case "home":
		return "Home"
	case "end":
		return "End"
	case "pageup", "page_up", "prior":
		return "PageUp"
	case "pagedown", "page_down", "next":
		return "PageDown"
	case "super", "cmd", "win", "meta", "logo":
		return "Super"
	case "space":
		return " "
	}
	if r := []rune(k); len(r) == 1 {
		if _, _, ok := runeToKey(r[0]); ok {
			return k // char suelto resoluble en layout US
		}
	}
	return ""
}
