//go:build linux

package input

import "testing"

func TestPointerGeometryMatchesEstablishedTouchpadAxes(t *testing.T) {
	profile := legacyPointerGeometryProfile(1)
	d := &uinputDevice{mt: &mtTouchpad{state: newMTState(devMaxX, devMaxY), res: devRes}, geometry: &profile}
	profile, ok := d.PointerGeometry()
	if !ok {
		t.Fatal("established mobile touchpad did not expose geometry")
	}
	if profile.ID != "legacy-100x70" || profile.Kind != "legacy-aspect-fit" {
		t.Fatalf("profile = %+v, want established legacy profile", profile)
	}
	if profile.WidthMM != 100 || profile.HeightMM != 70 || profile.GeometryEpoch != 1 {
		t.Fatalf("profile dimensions = %+v, want 100x70mm epoch 1", profile)
	}
}

func TestPointerGeometryOmitsUnpromotedFixtureAxes(t *testing.T) {
	d := &uinputDevice{mt: &mtTouchpad{state: newMTState(2800, 2800), res: devRes}}
	if profile, ok := d.PointerGeometry(); ok {
		t.Fatalf("fixture geometry advertised as production profile: %+v", profile)
	}
}
