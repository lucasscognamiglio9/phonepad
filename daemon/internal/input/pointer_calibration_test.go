package input

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"phonepad/daemon/internal/privatefs"
)

func testSquareCalibration() PointerGeometry {
	return PointerGeometry{ID: "square-centered", Kind: "square-centered", SideMM: 100,
		GainMMPerPoint: 100.0 / 844.0, GainSource: "calibrated",
		GainMinMMPerPoint: .05, GainMaxMMPerPoint: .25}
}

func TestPointerCalibrationRoundTripsPerDeviceAndKeepsUnknownEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pointer-geometry.json")
	first := testSquareCalibration()
	if err := SavePointerCalibration(path, "iphone-main", first); err != nil {
		t.Fatal(err)
	}
	second := testSquareCalibration()
	second.SideMM = 120
	if err := SavePointerCalibration(path, "iphone-spare", second); err != nil {
		t.Fatal(err)
	}
	got, ok, err := LoadPointerCalibration(path, "iphone-main")
	if err != nil || !ok {
		t.Fatalf("LoadPointerCalibration(main) = (%+v, %v, %v)", got, ok, err)
	}
	if got.SideMM != first.SideMM || got.GeometryEpoch != 0 {
		t.Fatalf("main profile = %+v, want persisted profile without live epoch", got)
	}
	got, ok, err = LoadPointerCalibration(path, "iphone-spare")
	if err != nil || !ok || got.SideMM != second.SideMM {
		t.Fatalf("LoadPointerCalibration(spare) = (%+v, %v, %v)", got, ok, err)
	}
	if private, err := privatefs.IsPrivate(path, false); err != nil || !private {
		t.Fatalf("calibration file private=%v, err=%v", private, err)
	}
}

func TestPointerCalibrationRejectsMalformedOrOutOfBoundsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pointer-geometry.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"devices":{"iphone-main":{"id":"square-centered","kind":"square-centered","sideMm":1,"gainMmPerPoint":0.1,"gainSource":"calibrated","gainMinMmPerPoint":0.05,"gainMaxMmPerPoint":0.25}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := LoadPointerCalibration(path, "iphone-main"); !errors.Is(err, ErrInvalidPointerCalibration) || ok {
		t.Fatalf("out-of-bounds calibration = (%v, %v), want invalid and absent", ok, err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"devices":{"iphone-main":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := LoadPointerCalibration(path, "iphone-main"); !errors.Is(err, ErrInvalidPointerCalibration) || ok {
		t.Fatalf("malformed calibration = (%v, %v), want invalid and absent", ok, err)
	}
	if err := os.WriteFile(path, []byte(`{"version":9,"devices":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := LoadPointerCalibration(path, "iphone-main"); !errors.Is(err, ErrUnsupportedPointerCalibration) || ok {
		t.Fatalf("future calibration = (%v, %v), want unsupported and absent", ok, err)
	}
}
