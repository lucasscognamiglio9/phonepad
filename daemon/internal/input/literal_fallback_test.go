//go:build linux

package input

import (
	"context"
	"strings"
	"testing"
)

func TestLiteralFallbackTargetAndBounds(t *testing.T) {
	if len(clipboardFallbackTarget) != 64 {
		t.Fatalf("fallback target length = %d, want 64", len(clipboardFallbackTarget))
	}
	d := &uinputDevice{}
	for _, text := range []string{strings.Repeat("a", literalMaxBytes+1), "nul\x00"} {
		result := d.LiteralText(context.Background(), text, clipboardFallbackTarget)
		if result.State != "rejected" || result.Detail != "invalid_literal" {
			t.Fatalf("invalid fallback text result = %+v", result)
		}
	}
}
