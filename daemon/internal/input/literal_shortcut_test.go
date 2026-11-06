//go:build linux

package input

import "testing"

func TestClipboardFallbackIsOnUnlessDisabled(t *testing.T) {
	for value, want := range map[string]string{"": "ctrl-v", "ctrl-v": "ctrl-v", " Ctrl-Shift-V ": "ctrl-shift-v", "off": ""} {
		t.Setenv(clipboardFallbackShortcutEnv, value)
		if got := clipboardFallbackShortcut(); got != want {
			t.Fatalf("%q -> %q, want %q", value, got, want)
		}
	}
}
