package input

import (
	"errors"
	"math"
	"testing"
	"time"
)

type linearProbe struct {
	moves   [][2]float64
	buttons []bool
	frames  [][]Contact
	cancels int
	fail    bool
}

func newLinearProbe() (*linearTouch, *linearProbe) {
	f := &linearProbe{}
	p := &linearTouch{move: func(x, y float64) error {
		f.moves = append(f.moves, [2]float64{x, y})
		if f.fail {
			return errors.New("lost")
		}
		return nil
	}, button: func(d bool) error { f.buttons = append(f.buttons, d); return nil }, multiTouch: func(c []Contact) { f.frames = append(f.frames, append([]Contact{}, c...)) }, cancelMulti: func() { f.cancels++ }}
	return p, f
}
func TestLinearMotionPreservesFractionsAndIgnoresFingerVelocity(t *testing.T) {
	g := PointerGeometry{Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70}
	for _, dt := range []time.Duration{time.Millisecond, 100 * time.Millisecond} {
		p, f := newLinearProbe()
		now := time.Unix(0, 0)
		p.frame([]Contact{{ID: 1, X: .5, Y: .5}}, g, now)
		for i := 1; i <= 10; i++ {
			p.frame([]Contact{{ID: 1, X: .5 + float64(i)*.0001, Y: .5}}, g, now.Add(time.Duration(i)*dt))
		}
		total := 0.0
		for _, m := range f.moves {
			total += m[0]
		}
		if math.Abs(total-2) > .0000001 {
			t.Fatalf("%v: got %.9f", dt, total)
		}
		if len(f.buttons) != 0 {
			t.Fatal("motion synthesized a button")
		}
	}
}
func TestLinearTapDoubleTapDragAndCancellation(t *testing.T) {
	g := PointerGeometry{Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70}
	p, f := newLinearProbe()
	now := time.Unix(1, 0)
	c := Contact{ID: 1, X: .5, Y: .5}
	p.frame([]Contact{c}, g, now)
	p.frame(nil, g, now.Add(50*time.Millisecond))
	if len(f.buttons) != 2 || !f.buttons[0] || f.buttons[1] {
		t.Fatal(f.buttons)
	}
	p.frame([]Contact{c}, g, now.Add(100*time.Millisecond))
	c.X = .6
	p.frame([]Contact{c}, g, now.Add(150*time.Millisecond))
	p.cancel()
	n := len(f.buttons)
	if n != 4 || !f.buttons[2] || f.buttons[3] {
		t.Fatal(f.buttons)
	}
	p.frame(nil, g, now.Add(200*time.Millisecond))
	if len(f.buttons) != n {
		t.Fatal("cancel created a click")
	}
}
func TestLinearMultitouchIsDelegatedAndNeverBecomesAPointerTap(t *testing.T) {
	g := PointerGeometry{Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70}
	p, f := newLinearProbe()
	now := time.Now()
	p.frame([]Contact{{ID: 1, X: .5, Y: .5}}, g, now)
	p.frame([]Contact{{ID: 1, X: .5, Y: .5}, {ID: 2, X: .6, Y: .5}}, g, now)
	p.frame([]Contact{{ID: 1, X: .7, Y: .5}}, g, now)
	p.frame(nil, g, now)
	if len(f.frames) != 3 || len(f.moves) != 0 || len(f.buttons) != 0 {
		t.Fatal(f)
	}
}
func TestLinearFailedMotionDoesNotReplayAndReplacementDoesNotClick(t *testing.T) {
	g := PointerGeometry{Kind: "legacy-aspect-fit", WidthMM: 100, HeightMM: 70}
	p, f := newLinearProbe()
	now := time.Now()
	p.frame([]Contact{{ID: 1, X: .5, Y: .5}}, g, now)
	f.fail = true
	p.frame([]Contact{{ID: 1, X: .6, Y: .5}}, g, now)
	p.frame([]Contact{{ID: 1, X: .7, Y: .5}}, g, now)
	p.frame(nil, g, now)
	if len(f.moves) != 1 || len(f.buttons) != 0 {
		t.Fatal("failed input replayed", f)
	}
	p, f = newLinearProbe()
	p.frame([]Contact{{ID: 1, X: .5, Y: .5}}, g, now)
	p.frame([]Contact{{ID: 2, X: .5, Y: .5}}, g, now)
	p.frame(nil, g, now)
	if len(f.buttons) != 0 || f.cancels != 1 {
		t.Fatal("replacement clicked", f)
	}
}
