//go:build linux

package input

import (
	"testing"
	"unicode"
)

// Keep native shortcut validation aligned with the Linux scancode table.
func TestUSKeyRuneMatchesLinuxScancodeResolver(t *testing.T) {
	for r := rune(0); r <= unicode.MaxRune; r++ {
		_, _, want := runeToKey(r)
		if got := isUSKeyRune(r); got != want {
			t.Fatalf("isUSKeyRune(%U) = %v, runeToKey ok = %v", r, got, want)
		}
	}
}
