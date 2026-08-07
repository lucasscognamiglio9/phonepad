package main

import "strings"

// scrollDelta traduce una dirección + cantidad de notches al (dx,dy) que espera
// input.Scroll. dy>0 sube, dx>0 va a la derecha; dirección desconocida → (0,0).
// (La traducción de teclas vive en internal/input.ParseKeyCombo, junto al keymap.)
func scrollDelta(dir string, amount int) (dx, dy int) {
	switch strings.ToLower(dir) {
	case "up":
		return 0, amount
	case "down":
		return 0, -amount
	case "left":
		return -amount, 0
	case "right":
		return amount, 0
	}
	return 0, 0
}
