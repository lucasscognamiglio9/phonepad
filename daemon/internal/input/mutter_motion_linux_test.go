//go:build linux

package input

import (
	"os"
	"sort"
	"testing"
	"time"
)

// Explicit desktop integration check: tiny balanced motion, no button presses.
func TestMutterRelativeMotionIntegration(t *testing.T) {
	if os.Getenv("PHONEPAD_TEST_MUTTER") != "1" {
		t.Skip("requires explicit desktop validation")
	}
	motion, err := newMutterMotion()
	if err != nil {
		t.Fatal(err)
	}
	defer motion.Close()
	durations := make([]time.Duration, 0, 64)
	for i := 0; i < 64; i++ {
		delta := .125
		if i%2 == 1 {
			delta = -delta
		}
		start := time.Now()
		if err := motion.Move(delta, 0); err != nil {
			t.Fatal(err)
		}
		durations = append(durations, time.Since(start))
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	t.Logf("64 native relative motions: p50=%s p95=%s", durations[32], durations[60])
	motion.Close()
	if err := motion.Move(.125, 0); err == nil {
		t.Fatal("closed session accepted motion")
	}
}
