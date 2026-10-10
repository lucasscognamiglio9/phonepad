//go:build linux

package input

import (
	"context"
	"time"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

type predictionMonitorSpec struct{ Connector, Vendor, Product, Serial string }
type predictionMode struct {
	ID                      string
	Width, Height           int32
	Refresh, PreferredScale float64
	Scales                  []float64
	Properties              map[string]dbus.Variant
}
type predictionMonitor struct {
	Spec       predictionMonitorSpec
	Modes      []predictionMode
	Properties map[string]dbus.Variant
}
type predictionLogicalMonitor struct {
	X, Y       int32
	Scale      float64
	Transform  uint32
	Primary    bool
	Monitors   []predictionMonitorSpec
	Properties map[string]dbus.Variant
}

func predictionDesktopScale(monitors []predictionMonitor, logical []predictionLogicalMonitor, layoutMode uint32) (float64, bool) {
	// Mutter injects relative motion in logical pixels, while cursor metadata
	// belongs to the physical 1080p stream. Accept only the logical layout and
	// scales verified with native injection and the production metadata reader.
	if layoutMode != 1 || len(logical) != 1 || logical[0].X != 0 || logical[0].Y != 0 || logical[0].Transform != 0 || len(logical[0].Monitors) == 0 {
		return 0, false
	}
	scale := logical[0].Scale
	if scale != 1 && scale != 1.25 && scale != 1.5 && scale != 2 {
		return 0, false
	}
	for _, spec := range logical[0].Monitors {
		found := false
		for _, monitor := range monitors {
			if monitor.Spec != spec {
				continue
			}
			for _, mode := range monitor.Modes {
				current, _ := mode.Properties["is-current"].Value().(bool)
				if current && mode.Width == 1920 && mode.Height == 1080 {
					found = true
				}
			}
		}
		if !found {
			return 0, false
		}
	}
	return scale, true
}
func (p *mutterMotion) predictionDesktop() (float64, bool) {
	if p.conn == nil || p.failed || p.session == nil {
		return 0, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var serial uint32
	var monitors []predictionMonitor
	var logical []predictionLogicalMonitor
	var properties map[string]dbus.Variant
	err := p.conn.Object("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig").CallWithContext(ctx, "org.gnome.Mutter.DisplayConfig.GetCurrentState", 0).Store(&serial, &monitors, &logical, &properties)
	if err != nil {
		return 0, false
	}
	layoutMode, _ := properties["layout-mode"].Value().(uint32)
	return predictionDesktopScale(monitors, logical, layoutMode)
}
func (d *uinputDevice) PointerPrediction() (PointerPrediction, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.motion == nil || d.linear == nil || d.linear.blocked {
		return PointerPrediction{}, false
	}
	scale, compatible := d.motion.predictionDesktop()
	if !compatible {
		return PointerPrediction{}, false
	}
	return PointerPrediction{PixelsPerMM: linearPixelsPerMM * scale, Width: 1920, Height: 1080}, true
}
func (d *uinputDevice) PointerFence() (uint64, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.motion == nil || d.linear == nil || d.linear.blocked {
		return 0, false
	}
	if _, compatible := d.motion.predictionDesktop(); !compatible {
		return 0, false
	}
	var now unix.Timespec
	if unix.ClockGettime(unix.CLOCK_MONOTONIC, &now) != nil {
		return 0, false
	}
	return uint64(now.Sec)*1000000 + uint64(now.Nsec)/1000, true
}
