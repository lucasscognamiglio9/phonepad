package input

import "strings"

// usKeyRunes is the exact set accepted by the Linux keymap's asciiNoShift and
// asciiShift tables. Keeping this validation as protocol vocabulary avoids
// importing Linux scancodes into ParseKeyCombo on other platforms.
const usKeyRunes = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t-=[]\\;'`,./!@#$%^&*()_+{}|:\"~<>?"

func isUSKeyRune(r rune) bool {
	return strings.ContainsRune(usKeyRunes, r)
}
