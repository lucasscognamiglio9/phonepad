//go:build linux

package input

import (
	"context"
	"testing"
)

func TestComboActionReportsModifierFailureAndAttemptsCleanup(t *testing.T) {
	k := &recordingKeyboard{failDown: true}
	d := &uinputDevice{kbd: k, held: make(map[int]struct{}), btns: make(map[string]bool)}
	result := d.ComboAction(context.Background(), []string{"ctrl"}, "c")
	if result.State != "uncertain" || result.Detail != "uinput_keydown_interrupted" {
		t.Fatalf("combo result = %+v, want uncertain modifier failure", result)
	}
	if len(d.held) != 0 {
		t.Fatalf("failed modifier remained held after cleanup: %v", d.held)
	}
}
