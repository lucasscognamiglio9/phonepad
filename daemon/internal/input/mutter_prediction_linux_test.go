//go:build linux

package input

import (
	"math"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestPredictionMapsValidatedLogicalScalesToPhysicalStream(t *testing.T) {
	spec := predictionMonitorSpec{Connector: "private"}
	monitor := predictionMonitor{Spec: spec, Modes: []predictionMode{{Width: 1920, Height: 1080, Properties: map[string]dbus.Variant{"is-current": dbus.MakeVariant(true)}}}}
	monitors := []predictionMonitor{monitor}
	base := predictionLogicalMonitor{Scale: 1, Monitors: []predictionMonitorSpec{spec}}
	for _, scale := range []float64{1, 1.25, 1.5, 2} {
		desktop := base
		desktop.Scale = scale
		got, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{desktop}, 1)
		if !ok || got != scale {
			t.Fatalf("validated scale %v rejected: %v %v", scale, got, ok)
		}
	}
	mirrored := monitor
	mirrored.Spec.Connector = "capture"
	desktop := base
	desktop.Scale = 1.25
	desktop.Monitors = append([]predictionMonitorSpec{spec}, mirrored.Spec)
	if scale, ok := predictionDesktopScale(append(monitors, mirrored), []predictionLogicalMonitor{desktop}, 1); !ok || scale != 1.25 {
		t.Fatal("physical monitor and capture mirror at 125% rejected")
	}
	mirrored.Modes = []predictionMode{{Width: 1280, Height: 720, Properties: monitor.Modes[0].Properties}}
	if _, ok := predictionDesktopScale(append(monitors, mirrored), []predictionLogicalMonitor{desktop}, 1); ok {
		t.Fatal("mirror with a different physical resolution accepted")
	}
	for _, scale := range []float64{0, -1, 1.1, 4, math.NaN(), math.Inf(1)} {
		altered := base
		altered.Scale = scale
		if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{altered}, 1); ok {
			t.Fatalf("unvalidated scale %v accepted", scale)
		}
	}
	for _, altered := range []predictionLogicalMonitor{{Scale: 1, Transform: 1, Monitors: base.Monitors}, {Scale: 1, X: 1920, Monitors: base.Monitors}, {Scale: 1, Y: -1080, Monitors: base.Monitors}, {Scale: 1}} {
		if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{altered}, 1); ok {
			t.Fatalf("unsafe desktop accepted: %+v", altered)
		}
	}
	if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{base, base}, 1); ok {
		t.Fatal("multiple logical monitors accepted")
	}
	for _, mode := range []uint32{0, 2, 3} {
		if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{base}, mode); ok {
			t.Fatalf("unknown or physical layout %d accepted", mode)
		}
	}
	monitors[0].Modes[0].Width = 1280
	if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{base}, 1); ok {
		t.Fatal("different physical resolution accepted")
	}
	monitors[0].Modes[0].Width = 1920
	monitors[0].Modes[0].Properties["is-current"] = dbus.MakeVariant(false)
	if _, ok := predictionDesktopScale(monitors, []predictionLogicalMonitor{base}, 1); ok {
		t.Fatal("inactive mode accepted")
	}
	if _, ok := (&uinputDevice{}).PointerPrediction(); ok {
		t.Fatal("missing native provider advertised prediction")
	}
	if _, ok := (&uinputDevice{}).PointerFence(); ok {
		t.Fatal("missing native provider acknowledged fence")
	}
}
