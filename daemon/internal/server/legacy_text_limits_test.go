package server

import (
	"strings"
	"testing"
)

func TestLegacyTextLimitRejectsWithoutTruncation(t *testing.T) {
	for _, size := range []int{2048, maxTextBytes} {
		text := strings.Repeat("¿", size/2)
		if len(text) > maxTextBytes {
			t.Fatal("fixture unexpectedly exceeds byte limit")
		}
		raw := []byte(`{"t":"k","a":"text","text":"` + text + `"}`)
		message, ok := Parse(raw)
		if !ok || message.Text != text {
			t.Fatalf("legacy size %d was rejected or changed", size)
		}
	}
	tooLarge := []byte(`{"t":"k","a":"text","text":"` + strings.Repeat("a", maxTextBytes+1) + `"}`)
	if _, ok := Parse(tooLarge); ok {
		t.Fatal("legacy text over 8192 bytes was silently accepted")
	}
}
