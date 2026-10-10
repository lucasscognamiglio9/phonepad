package input

import "strings"

// ParseKeyCombo traduce un atajo como lo nombra un agente externo (computer use)
// — "ctrl+s", "Return", "alt+Tab", "super+a" — a (mods, key) listo para Combo.
// Los mods y nombres especiales usan el vocabulario canónico del protocolo; una
// tecla de un solo carácter se valida contra el layout ASCII US portable. La
// conversión final a scancode pertenece al proveedor Linux y no forma parte de
// este parser.
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
// agente) a su clave canónica. "" si no se reconoce.
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

// canonKey normaliza el nombre de una tecla a una clave especial o, si es un
// único carácter, lo deja pasar sólo si pertenece al layout ASCII US. "" si no
// se reconoce — así ParseKeyCombo conserva el límite de teclas que Combo puede
// ejecutar.
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
		if isUSKeyRune(r[0]) {
			return k // char suelto resoluble en layout US
		}
	}
	return ""
}
