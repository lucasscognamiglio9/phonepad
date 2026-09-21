//go:build linux

package input

import (
	"math"
	"testing"
)

const (
	testSquareSideMM = 100.0
	testSquareGain   = 100.0 / 844.0
	testResolution   = int32(28)
)

func squareContactForTest(id int, x, y, width, height float64) Contact {
	return Contact{
		ID: id,
		X:  (testSquareSideMM-testSquareGain*width)/(2*testSquareSideMM) + testSquareGain*x/testSquareSideMM,
		Y:  (testSquareSideMM-testSquareGain*height)/(2*testSquareSideMM) + testSquareGain*y/testSquareSideMM,
	}
}

func TestSquareOrientationTransitionKeepsOneTouchpadGeometry(t *testing.T) {
	state := newMTState(2800, 2800)
	portrait := squareContactForTest(7, 145, 422, 390, 844)
	landscape := squareContactForTest(7, 522, 195, 844, 390)
	state.frame([]Contact{portrait})
	state.cancel()
	state.frame([]Contact{landscape})

	if state.maxX != 2800 || state.maxY != 2800 {
		t.Fatalf("orientation transition changed the active uinput geometry: %dx%d", state.maxX, state.maxY)
	}
	if state.count != 1 || state.slotID[0] != 7 {
		t.Fatalf("landscape reclutch did not start a fresh contact: count=%d slots=%v", state.count, state.slotID)
	}
	if state.nextTID != 2 {
		t.Fatalf("reclutch tracking id=%d, want 2 after one fresh contact", state.nextTID)
	}
}

func TestTouchpadScaleKeepsSubpixelErrorAtSerializationBoundary(t *testing.T) {
	for _, value := range []float64{0, .0001, .123456789, .5, .876543211, .9999, 1} {
		got := scale(value, 2800)
		want := value * 2800
		if error := math.Abs(float64(got) - want); error > .5 {
			t.Fatalf("scale(%g)=%d differs from float coordinate %g by %g units", value, got, want, error)
		}
	}
}
