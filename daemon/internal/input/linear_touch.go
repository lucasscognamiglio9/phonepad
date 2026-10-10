package input

import (
	"math"
	"time"
)

// linearTouch owns single-finger pointer motion. Multitouch remains with the
// host recognizer. Its gain is distance-based, never arrival-time or velocity.
// The injector serializes calls and provides the already-applied geometry.
const linearPixelsPerMM = 20

type linearTouch struct {
	move                        func(float64, float64) error
	button                      func(bool) error
	multiTouch                  func([]Contact)
	cancelMulti                 func()
	previous                    *Contact
	start                       Contact
	started                     time.Time
	moved, multi, down, blocked bool
	lastTap                     time.Time
	lastTapContact              Contact
}

func (p *linearTouch) frame(cs []Contact, geometry PointerGeometry, now time.Time) {
	if p.blocked {
		return
	}
	w, h := geometry.WidthMM, geometry.HeightMM
	if geometry.Kind == "square-centered" {
		w, h = geometry.SideMM, geometry.SideMM
	}
	if w <= 0 || h <= 0 {
		p.cancel()
		return
	}
	if len(cs) > 1 || p.multi {
		if !p.multi {
			p.release()
			p.previous = nil
			p.multi = true
			p.lastTap = time.Time{}
		}
		p.multiTouch(cs)
		if len(cs) == 0 {
			p.multi = false
		}
		return
	}
	if len(cs) == 0 {
		if p.previous != nil {
			if p.down {
				p.release()
			} else if !p.moved && now.Sub(p.started) <= 250*time.Millisecond {
				p.down = true
				err := p.button(true)
				p.release()
				if err != nil || p.blocked {
					p.blocked = true
				} else {
					p.lastTap = now
					p.lastTapContact = p.start
				}
			}
		}
		p.previous = nil
		return
	}
	c := cs[0]
	if p.previous == nil {
		p.start = c
		p.started = now
		p.moved = false
		if !p.lastTap.IsZero() && now.Sub(p.lastTap) < 300*time.Millisecond && math.Hypot((c.X-p.lastTapContact.X)*w, (c.Y-p.lastTapContact.Y)*h) < 3 {
			p.down = true
			if p.button(true) != nil {
				p.blocked = true
				p.release()
			}
		}
		p.lastTap = time.Time{}
	} else if c.ID != p.previous.ID {
		// A replacement without a release is cancellation, never a click.
		p.cancel()
		return
	} else {
		dx, dy := (c.X-p.previous.X)*w, (c.Y-p.previous.Y)*h
		if math.Hypot((c.X-p.start.X)*w, (c.Y-p.start.Y)*h) > .8 {
			p.moved = true
		}
		// One mm on the emulated surface maps to 20 logical display pixels.
		// Fractions reach the native API; slow motion is not rounded away.
		if (dx != 0 || dy != 0) && p.move(dx*linearPixelsPerMM, dy*linearPixelsPerMM) != nil {
			p.blocked = true
			p.release()
		}
	}
	next := c
	p.previous = &next
}
func (p *linearTouch) release() {
	if p.down {
		p.down = false
		if p.button(false) != nil {
			p.blocked = true
		}
	}
}
func (p *linearTouch) cancel() {
	p.release()
	p.cancelMulti()
	p.previous = nil
	p.multi = false
	p.lastTap = time.Time{}
}
