package main

import "testing"

func TestScrollDelta(t *testing.T) {
	cases := []struct {
		dir            string
		amount, dx, dy int
	}{
		{"up", 3, 0, 3},
		{"down", 3, 0, -3},
		{"left", 2, -2, 0},
		{"right", 5, 5, 0},
		{"sideways", 3, 0, 0}, // desconocida → sin movimiento
	}
	for _, c := range cases {
		dx, dy := scrollDelta(c.dir, c.amount)
		if dx != c.dx || dy != c.dy {
			t.Errorf("scrollDelta(%q,%d) = (%d,%d), want (%d,%d)", c.dir, c.amount, dx, dy, c.dx, c.dy)
		}
	}
}
