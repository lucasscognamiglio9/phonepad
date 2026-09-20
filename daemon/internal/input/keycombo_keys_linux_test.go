//go:build linux

package input

import (
	"testing"
	"unicode"
)

// Keep the portable parser vocabulary exactly aligned with the Linux provider's
// scancode table. Iterate the complete Unicode range so a future keymap edit
// cannot silently widen or narrow ParseKeyCombo on another platform.
func TestUSKeyRuneMatchesLinuxScancodeResolver(t *testing.T) {
	for r := rune(0); r <= unicode.MaxRune; r++ {
		_, _, want := runeToKey(r)
		if got := isUSKeyRune(r); got != want {
			t.Fatalf("isUSKeyRune(%U) = %v, runeToKey ok = %v", r, got, want)
		}
	}
}
