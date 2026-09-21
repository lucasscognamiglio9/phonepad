package input

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
)

const (
	PointerGeometrySchemaVersion  = 1
	MobilePointerGeometryDeviceID = "phonepad-touchpad"
	minSquareSideMM               = 50
	maxSquareSideMM               = 200
	minSquareGainMMPerPoint       = 0.05
	maxSquareGainMMPerPoint       = 0.25
	maxPointerCalibrationBytes    = 64 << 10
)

var validPointerDeviceID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

var (
	ErrInvalidPointerCalibration     = errors.New("invalid pointer calibration")
	ErrUnsupportedPointerCalibration = errors.New("unsupported pointer calibration version")
	ErrPointerGeometryUnavailable    = errors.New("pointer geometry unavailable")
)

type pointerCalibrationDocument struct {
	Version int                        `json:"version"`
	Devices map[string]PointerGeometry `json:"devices"`
}

// ValidatePointerGeometry accepts only the calibrated square profile. The
// legacy profile is a runtime fallback and is never loaded as calibration.
// Bounds keep a bad hand-edited file from creating a huge or hypersensitive
// uinput device. GeometryEpoch is assigned by the live provider.
func ValidatePointerGeometry(profile PointerGeometry) error {
	finite := func(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
	if profile.ID != "square-centered" || profile.Kind != "square-centered" ||
		!finite(profile.SideMM) || !finite(profile.GainMMPerPoint) || !finite(profile.GainMinMMPerPoint) || !finite(profile.GainMaxMMPerPoint) ||
		profile.SideMM < minSquareSideMM || profile.SideMM > maxSquareSideMM ||
		profile.GainMMPerPoint < minSquareGainMMPerPoint || profile.GainMMPerPoint > maxSquareGainMMPerPoint ||
		profile.GainSource != "calibrated" || profile.GainMinMMPerPoint < minSquareGainMMPerPoint ||
		profile.GainMaxMMPerPoint > maxSquareGainMMPerPoint || profile.GainMinMMPerPoint > profile.GainMaxMMPerPoint ||
		profile.GainMMPerPoint < profile.GainMinMMPerPoint || profile.GainMMPerPoint > profile.GainMaxMMPerPoint ||
		profile.WidthMM != 0 || profile.HeightMM != 0 {
		return ErrInvalidPointerCalibration
	}
	return nil
}

// LoadPointerCalibration reads one device-local profile. Missing files and
// missing device entries are a normal legacy fallback; malformed documents
// are errors and are never silently replaced.
func LoadPointerCalibration(path, deviceID string) (PointerGeometry, bool, error) {
	if !validPointerDeviceID.MatchString(deviceID) {
		return PointerGeometry{}, false, ErrInvalidPointerCalibration
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return PointerGeometry{}, false, nil
	}
	if err != nil {
		return PointerGeometry{}, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxPointerCalibrationBytes+1))
	if err != nil {
		return PointerGeometry{}, false, err
	}
	if len(data) == 0 || len(data) > maxPointerCalibrationBytes {
		return PointerGeometry{}, false, ErrInvalidPointerCalibration
	}
	var document pointerCalibrationDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return PointerGeometry{}, false, fmt.Errorf("%w: %v", ErrInvalidPointerCalibration, err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return PointerGeometry{}, false, ErrInvalidPointerCalibration
	}
	if document.Version != PointerGeometrySchemaVersion || document.Devices == nil {
		return PointerGeometry{}, false, ErrUnsupportedPointerCalibration
	}
	if err := validatePointerCalibrationDocument(document); err != nil {
		return PointerGeometry{}, false, err
	}
	profile, ok := document.Devices[deviceID]
	if !ok {
		return PointerGeometry{}, false, nil
	}
	if profile.GeometryEpoch != 0 {
		return PointerGeometry{}, false, ErrInvalidPointerCalibration
	}
	if err := ValidatePointerGeometry(profile); err != nil {
		return PointerGeometry{}, false, err
	}
	return profile, true, nil
}

// SavePointerCalibration atomically updates one device entry, retaining other
// devices. It is intended for an explicit calibration tool/operator action;
// runtime input never writes calibration as a side effect of a session.
func SavePointerCalibration(path, deviceID string, profile PointerGeometry) error {
	if !validPointerDeviceID.MatchString(deviceID) {
		return ErrInvalidPointerCalibration
	}
	if err := ValidatePointerGeometry(profile); err != nil {
		return err
	}
	document := pointerCalibrationDocument{Version: PointerGeometrySchemaVersion, Devices: map[string]PointerGeometry{}}
	if existing, ok, err := loadPointerCalibrationDocument(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if ok {
		document = existing
	}
	if document.Devices == nil {
		document.Devices = make(map[string]PointerGeometry)
	}
	profile.GeometryEpoch = 0
	document.Devices[deviceID] = profile
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pointer-geometry-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = tmp.Close(); _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// loadPointerCalibrationDocument is kept separate so Save can preserve
// unrelated device entries while the public loader remains device-scoped.
func loadPointerCalibrationDocument(path string) (pointerCalibrationDocument, bool, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return pointerCalibrationDocument{}, false, os.ErrNotExist
	}
	if err != nil {
		return pointerCalibrationDocument{}, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxPointerCalibrationBytes+1))
	if err != nil {
		return pointerCalibrationDocument{}, false, err
	}
	if len(data) == 0 || len(data) > maxPointerCalibrationBytes {
		return pointerCalibrationDocument{}, false, ErrInvalidPointerCalibration
	}
	var document pointerCalibrationDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return pointerCalibrationDocument{}, false, fmt.Errorf("%w: %v", ErrInvalidPointerCalibration, err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return pointerCalibrationDocument{}, false, ErrInvalidPointerCalibration
	}
	if document.Version != PointerGeometrySchemaVersion || document.Devices == nil {
		return pointerCalibrationDocument{}, false, ErrUnsupportedPointerCalibration
	}
	if err := validatePointerCalibrationDocument(document); err != nil {
		return pointerCalibrationDocument{}, false, err
	}
	return document, true, nil
}

func validatePointerCalibrationDocument(document pointerCalibrationDocument) error {
	for deviceID, profile := range document.Devices {
		if !validPointerDeviceID.MatchString(deviceID) || profile.GeometryEpoch != 0 {
			return ErrInvalidPointerCalibration
		}
		if err := ValidatePointerGeometry(profile); err != nil {
			return err
		}
	}
	return nil
}
