//go:build linux

package input

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"
)

const (
	p04MotionFixtureEnv = "PHONEPAD_P04_MOTION_FIXTURE_DIR"
	p04MotionCasesEnv   = "PHONEPAD_P04_MOTION_CASES"
	p04MotionTimeout    = 70 * time.Second
	p04MotionResolution = int32(28)
	p04MotionIsoGain    = 100.0 / 844.0
	p04MotionSquareMM   = 100.0
)

type p04MotionCase struct {
	Name       string  `json:"name"`
	Mapper     string  `json:"mapper"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
	MaxX       int32   `json:"maxX"`
	MaxY       int32   `json:"maxY"`
	Resolution int32   `json:"resolution"`
}

type p04MotionTrace struct {
	Name      string  `json:"name"`
	Axis      string  `json:"axis"`
	Direction string  `json:"direction"`
	Speed     string  `json:"speed"`
	DelayMS   int     `json:"delayMs"`
	Start     float64 `json:"start"`
	End       float64 `json:"end"`
	Steps     int     `json:"steps"`
}

type p04TransitionTrace struct {
	Name        string  `json:"name"`
	Orientation string  `json:"orientation"`
	Axis        string  `json:"axis"`
	Direction   string  `json:"direction"`
	Speed       string  `json:"speed"`
	DelayMS     int     `json:"delayMs"`
	StartPoint  float64 `json:"startPoint"`
	EndPoint    float64 `json:"endPoint"`
	Steps       int     `json:"steps"`
}

type p04MotionDevice struct {
	Device  string           `json:"device"`
	Sysname string           `json:"sysname"`
	Case    p04MotionCase    `json:"case"`
	Profile string           `json:"profile"`
	Traces  []p04MotionTrace `json:"traces"`
}

type p04MotionAcceleration struct {
	Profile           int  `json:"profile"`
	DefaultProfile    int  `json:"defaultProfile"`
	AvailableProfiles int  `json:"availableProfiles"`
	ProfileChanged    bool `json:"profileChanged"`
}

type p04MotionEvent struct {
	Stage           string  `json:"stage"`
	TimeUsec        uint64  `json:"timeUsec"`
	DX              float64 `json:"dx"`
	DY              float64 `json:"dy"`
	DXUnaccelerated float64 `json:"dxUnaccelerated"`
	DYUnaccelerated float64 `json:"dyUnaccelerated"`
}

type p04MotionReport struct {
	Fixture          p04MotionDevice       `json:"fixture"`
	ExclusiveGrab    bool                  `json:"exclusiveGrab"`
	Acceleration     p04MotionAcceleration `json:"acceleration"`
	EventCount       int                   `json:"eventCount"`
	MotionEventCount int                   `json:"motionEventCount"`
	Motions          []p04MotionEvent      `json:"motions"`
}

type p04MotionSummary struct {
	RunDir string            `json:"runDir"`
	Cases  []json.RawMessage `json:"cases"`
}

type p04MotionAnalysis struct {
	Case                     string
	Stage                    string
	Axis                     string
	Direction                string
	Events                   int
	AxisAccelerated          float64
	PerpendicularAccelerated float64
	AxisRaw                  float64
	PerpendicularRaw         float64
	RawMM                    float64
	MMPerPoint               float64
}

// TestNativeTouchpadMotionFixture is opt-in because it creates a real uinput
// device and opens the installed libinput ABI. The observer grabs the exact
// event node before this test emits its first frame. Every case gets its own
// device and evidence directory, so a failed case remains inspectable.
func TestNativeTouchpadMotionFixture(t *testing.T) {
	base := os.Getenv(p04MotionFixtureEnv)
	if base == "" {
		t.Skip("native libinput motion fixture is opt-in")
	}
	if !filepath.IsAbs(base) {
		t.Fatalf("%s must be an absolute private fixture directory", p04MotionFixtureEnv)
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(base, fmt.Sprintf("run-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(runDir, 0700); err != nil {
		t.Fatal(err)
	}

	cases, err := p04MotionCases()
	if err != nil {
		t.Fatal(err)
	}

	reports := make([]json.RawMessage, 0, len(cases))
	for _, motionCase := range cases {
		report, err := runP04MotionCase(t, runDir, motionCase)
		if err != nil {
			t.Fatalf("%s: %v", motionCase.Name, err)
		}
		reports = append(reports, report)
	}
	summary := struct {
		RunDir string            `json:"runDir"`
		Cases  []json.RawMessage `json:"cases"`
	}{RunDir: runDir, Cases: reports}
	if err := writeP04JSON(filepath.Join(runDir, "summary.json"), summary); err != nil {
		t.Fatal(err)
	}
	t.Logf("P04 motion evidence preserved at %s", runDir)
}

// TestP04SquareOrientationTransitionFixture is opt-in. It deliberately keeps
// one 100x100mm uinput instance alive while the logical surface changes from
// portrait to landscape. The producer cancels between orientations, then
// emits equal 100-point traces at the same cadence; the observer measures
// unaccelerated motion and grabs only this private event node.
func TestP04SquareOrientationTransitionFixture(t *testing.T) {
	base := os.Getenv(p04MotionFixtureEnv)
	if base == "" {
		t.Skip("native libinput transition fixture is opt-in")
	}
	if !filepath.IsAbs(base) {
		t.Fatalf("%s must be an absolute private fixture directory", p04MotionFixtureEnv)
	}
	runDir := filepath.Join(base, fmt.Sprintf("transition-%d", time.Now().UnixNano()))
	caseDir := filepath.Join(runDir, "square-transition-same-uinput")
	if err := os.MkdirAll(caseDir, 0700); err != nil {
		t.Fatal(err)
	}
	traces := p04TransitionTraces()
	if err := writeP04JSON(filepath.Join(caseDir, "traces.json"), traces); err != nil {
		t.Fatal(err)
	}
	observer, err := p04MotionObserverPath()
	if err != nil {
		t.Fatal(err)
	}
	logFile, err := os.OpenFile(filepath.Join(caseDir, "observer.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	pad, err := newMTTouchpadWithGeometry(p04MotionAxis(p04MotionSquareMM), p04MotionAxis(p04MotionSquareMM), p04MotionResolution)
	if err != nil {
		t.Fatal(err)
	}
	defer pad.close()
	sysname, device, err := p04MotionDevicePath(pad)
	if err != nil {
		t.Fatal(err)
	}
	metadata := p04MotionDevice{
		Device: device, Sysname: sysname,
		Case: p04MotionCase{Name: "square-transition-same-uinput", Mapper: "square-centered", Width: 0, Height: 0,
			MaxX: p04MotionAxis(p04MotionSquareMM), MaxY: p04MotionAxis(p04MotionSquareMM), Resolution: p04MotionResolution},
		Profile: "default",
	}
	if err := writeP04JSON(filepath.Join(caseDir, "device.json"), metadata); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/usr/bin/python3", observer, caseDir)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitObserver := func() error {
		wait := make(chan error, 1)
		go func() { wait <- cmd.Wait() }()
		select {
		case err := <-wait:
			return err
		case <-time.After(p04MotionTimeout):
			_ = cmd.Process.Kill()
			<-wait
			return fmt.Errorf("observer timeout after %s", p04MotionTimeout)
		}
	}
	if err := p04MotionWaitFor(filepath.Join(caseDir, "start"), p04MotionTimeout); err != nil {
		_ = cmd.Process.Kill()
		_ = waitObserver()
		t.Fatal(err)
	}
	for index, trace := range traces {
		if err := os.WriteFile(filepath.Join(caseDir, "stage"), []byte(trace.Name), 0600); err != nil {
			_ = cmd.Process.Kill()
			_ = waitObserver()
			t.Fatal(err)
		}
		emitP04TransitionTrace(pad, trace)
		if index == len(traces)/2-1 {
			// The same uinput device stays open; only active contacts are
			// canceled before the new orientation starts.
			pad.cancel()
			time.Sleep(120 * time.Millisecond)
		}
	}
	if err := os.WriteFile(filepath.Join(caseDir, "done"), []byte("done"), 0600); err != nil {
		_ = cmd.Process.Kill()
		_ = waitObserver()
		t.Fatal(err)
	}
	if err := waitObserver(); err != nil {
		t.Fatalf("observer: %v; see %s", err, filepath.Join(caseDir, "observer.log"))
	}
	data, err := os.ReadFile(filepath.Join(caseDir, "motion.json"))
	if err != nil {
		t.Fatal(err)
	}
	var report p04MotionReport
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	if !report.ExclusiveGrab || report.Fixture.Sysname != sysname {
		t.Fatalf("transition observer did not retain exclusive identity: grab=%v sysname=%q want=%q", report.ExclusiveGrab, report.Fixture.Sysname, sysname)
	}
	measurements := analyzeP04TransitionReport(t, report, traces)
	if err := writeP04JSON(filepath.Join(caseDir, "transition-summary.json"), map[string]any{
		"sameUinput": true, "sysname": sysname, "device": device,
		"resolution": p04MotionResolution, "measurements": measurements,
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("P04 same-uinput transition evidence preserved at %s", caseDir)
}

func p04TransitionTraces() []p04TransitionTrace {
	traces := make([]p04TransitionTrace, 0, 8)
	for _, orientation := range []struct {
		name   string
		width  float64
		height float64
	}{
		{name: "portrait", width: 390, height: 844},
		{name: "landscape", width: 844, height: 390},
	} {
		for _, axis := range []string{"x", "y"} {
			for _, direction := range []string{"positive", "negative"} {
				start, end := orientation.width/2-50, orientation.width/2+50
				if axis == "y" {
					start, end = orientation.height/2-50, orientation.height/2+50
				}
				if direction == "negative" {
					start, end = end, start
				}
				traces = append(traces, p04TransitionTrace{
					Name: fmt.Sprintf("%s-%s-%s", orientation.name, axis, direction), Orientation: orientation.name,
					Axis: axis, Direction: direction, Speed: "equal-100pt-8ms", DelayMS: 8,
					StartPoint: start, EndPoint: end, Steps: 25,
				})
			}
		}
	}
	return traces
}

func emitP04TransitionTrace(pad *mtTouchpad, trace p04TransitionTrace) {
	width, height := 390.0, 844.0
	if trace.Orientation == "landscape" {
		width, height = 844, 390
	}
	contact := func(value float64) Contact {
		x, y := width/2, height/2
		if trace.Axis == "x" {
			x = value
		} else {
			y = value
		}
		return p04SquareContact(1, x, y, width, height)
	}
	pad.touch([]Contact{contact(trace.StartPoint)})
	time.Sleep(50 * time.Millisecond)
	for index := 1; index <= trace.Steps; index++ {
		time.Sleep(time.Duration(trace.DelayMS) * time.Millisecond)
		fraction := float64(index) / float64(trace.Steps)
		pad.touch([]Contact{contact(trace.StartPoint + (trace.EndPoint-trace.StartPoint)*fraction)})
	}
	pad.touch(nil)
	time.Sleep(120 * time.Millisecond)
}

func analyzeP04TransitionReport(t *testing.T, report p04MotionReport, traces []p04TransitionTrace) []map[string]any {
	t.Helper()
	measurements := make([]map[string]any, 0, len(traces))
	for _, trace := range traces {
		var axisRaw, perpendicularRaw float64
		count := 0
		for _, motion := range report.Motions {
			if motion.Stage != trace.Name {
				continue
			}
			count++
			if trace.Axis == "x" {
				axisRaw += motion.DXUnaccelerated
				perpendicularRaw += motion.DYUnaccelerated
			} else {
				axisRaw += motion.DYUnaccelerated
				perpendicularRaw += motion.DXUnaccelerated
			}
		}
		if count == 0 || (trace.Direction == "positive" && axisRaw <= 0) || (trace.Direction == "negative" && axisRaw >= 0) {
			t.Fatalf("transition %s missing signed motion: events=%d raw=%g", trace.Name, count, axisRaw)
		}
		if math.Abs(perpendicularRaw) > p04MotionCrossAxisTolerance(axisRaw) {
			t.Fatalf("transition %s has perpendicular raw motion=%g axis=%g", trace.Name, perpendicularRaw, axisRaw)
		}
		rawMM := math.Abs(axisRaw) / float64(report.Fixture.Case.Resolution)
		wantMM := p04MotionIsoGain * 100
		if math.Abs(rawMM-wantMM) > .75 {
			t.Fatalf("transition %s raw gain=%gmm, want approximately %gmm", trace.Name, rawMM, wantMM)
		}
		measurements = append(measurements, map[string]any{
			"name": trace.Name, "orientation": trace.Orientation, "axis": trace.Axis,
			"direction": trace.Direction, "events": count, "rawMM": rawMM,
			"mmPerPoint": rawMM / 100,
		})
	}
	return measurements
}

func p04MotionCases() ([]p04MotionCase, error) {
	cases := []p04MotionCase{
		{Name: "current-portrait", Mapper: "current-aspect-fit", Width: 390, Height: 844, MaxX: devMaxX, MaxY: devMaxY, Resolution: devRes},
		{Name: "current-landscape", Mapper: "current-aspect-fit", Width: 844, Height: 390, MaxX: devMaxX, MaxY: devMaxY, Resolution: devRes},
		{Name: "isotropic-portrait", Mapper: "isotropic-invariant", Width: 390, Height: 844,
			MaxX: p04MotionAxis(390 * p04MotionIsoGain), MaxY: p04MotionAxis(844 * p04MotionIsoGain), Resolution: p04MotionResolution},
		{Name: "isotropic-landscape", Mapper: "isotropic-invariant", Width: 844, Height: 390,
			MaxX: p04MotionAxis(844 * p04MotionIsoGain), MaxY: p04MotionAxis(390 * p04MotionIsoGain), Resolution: p04MotionResolution},
		{Name: "square-portrait", Mapper: "square-centered", Width: 390, Height: 844,
			MaxX: p04MotionAxis(p04MotionSquareMM), MaxY: p04MotionAxis(p04MotionSquareMM), Resolution: p04MotionResolution},
		{Name: "square-landscape", Mapper: "square-centered", Width: 844, Height: 390,
			MaxX: p04MotionAxis(p04MotionSquareMM), MaxY: p04MotionAxis(p04MotionSquareMM), Resolution: p04MotionResolution},
	}
	filter := strings.TrimSpace(os.Getenv(p04MotionCasesEnv))
	if filter == "" {
		return cases, nil
	}
	wanted := make(map[string]bool)
	for _, name := range strings.Split(filter, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		wanted[name] = true
	}
	if len(wanted) == 0 {
		return nil, fmt.Errorf("%s must contain at least one case name", p04MotionCasesEnv)
	}
	selected := make([]p04MotionCase, 0, len(wanted))
	for _, motionCase := range cases {
		if wanted[motionCase.Name] {
			selected = append(selected, motionCase)
			delete(wanted, motionCase.Name)
		}
	}
	if len(wanted) != 0 {
		unknown := make([]string, 0, len(wanted))
		for name := range wanted {
			unknown = append(unknown, name)
		}
		return nil, fmt.Errorf("%s contains unknown case(s): %s", p04MotionCasesEnv, strings.Join(unknown, ","))
	}
	return selected, nil
}

func runP04MotionCase(t *testing.T, runDir string, motionCase p04MotionCase) (json.RawMessage, error) {
	t.Helper()
	caseDir := filepath.Join(runDir, motionCase.Name)
	if err := os.MkdirAll(caseDir, 0700); err != nil {
		return nil, err
	}
	traces := p04MotionTraces()
	if err := writeP04JSON(filepath.Join(caseDir, "traces.json"), traces); err != nil {
		return nil, err
	}

	observer, err := p04MotionObserverPath()
	if err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(caseDir, "observer.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()

	pad, err := newMTTouchpadWithGeometry(motionCase.MaxX, motionCase.MaxY, motionCase.Resolution)
	if err != nil {
		return nil, err
	}
	defer pad.close()

	sysname, device, err := p04MotionDevicePath(pad)
	if err != nil {
		return nil, err
	}
	metadata := p04MotionDevice{Device: device, Sysname: sysname, Case: motionCase, Profile: "default", Traces: traces}
	if err := writeP04JSON(filepath.Join(caseDir, "device.json"), metadata); err != nil {
		return nil, err
	}

	cmd := exec.Command("/usr/bin/python3", observer, caseDir)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start observer: %w", err)
	}
	waitObserver := func() error {
		wait := make(chan error, 1)
		go func() { wait <- cmd.Wait() }()
		select {
		case err := <-wait:
			return err
		case <-time.After(p04MotionTimeout):
			_ = cmd.Process.Kill()
			<-wait
			return fmt.Errorf("observer timeout after %s", p04MotionTimeout)
		}
	}
	if err := p04MotionWaitFor(filepath.Join(caseDir, "start"), p04MotionTimeout); err != nil {
		_ = cmd.Process.Kill()
		_ = waitObserver()
		return nil, err
	}

	for _, trace := range traces {
		if err := os.WriteFile(filepath.Join(caseDir, "stage"), []byte(trace.Name), 0600); err != nil {
			_ = cmd.Process.Kill()
			_ = waitObserver()
			return nil, err
		}
		emitP04MotionTrace(pad, motionCase, trace)
	}
	if err := os.WriteFile(filepath.Join(caseDir, "done"), []byte("done"), 0600); err != nil {
		_ = cmd.Process.Kill()
		_ = waitObserver()
		return nil, err
	}
	if err := waitObserver(); err != nil {
		return nil, fmt.Errorf("observer: %w; see %s", err, filepath.Join(caseDir, "observer.log"))
	}
	report, err := os.ReadFile(filepath.Join(caseDir, "motion.json"))
	if err != nil {
		return nil, fmt.Errorf("read observer evidence: %w", err)
	}
	if !json.Valid(report) {
		return nil, fmt.Errorf("observer evidence is not JSON")
	}
	if _, err := analyzeP04MotionReport(report); err != nil {
		return nil, fmt.Errorf("invalid observer evidence: %w", err)
	}
	return json.RawMessage(report), nil
}

func p04MotionObserverPath() (string, error) {
	if root := os.Getenv("PHONEPAD_REPO_ROOT"); root != "" {
		candidate := filepath.Join(root, "tools", "refactor", "p04_motion_observer.py")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	if _, source, _, ok := runtime.Caller(0); ok {
		for directory := filepath.Dir(source); ; directory = filepath.Dir(directory) {
			candidate := filepath.Join(directory, "tools", "refactor", "p04_motion_observer.py")
			if _, err := os.Stat(candidate); err == nil {
				return candidate, nil
			}
			parent := filepath.Dir(directory)
			if parent == directory {
				break
			}
		}
	}
	return "", fmt.Errorf("p04_motion_observer.py not found; set PHONEPAD_REPO_ROOT")
}

func TestP04MotionEvidenceAnalysis(t *testing.T) {
	path := os.Getenv("PHONEPAD_P04_MOTION_SUMMARY")
	if path == "" {
		t.Skip("P04 motion evidence analysis is opt-in")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	analyses, err := analyzeP04MotionSummary(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, analysis := range analyses {
		t.Logf("%s/%s: events=%d accelerated=%.6f raw=%.6f units rawMM=%.6f mmPerPoint=%.9f",
			analysis.Case, analysis.Stage, analysis.Events, analysis.AxisAccelerated, analysis.AxisRaw,
			analysis.RawMM, analysis.MMPerPoint)
	}
}

func TestP04SquareCenteredMapper(t *testing.T) {
	const tolerance = 1e-12
	gain := p04MotionIsoGain
	cases := []p04MotionCase{
		{Name: "square-portrait", Width: 390, Height: 844},
		{Name: "square-landscape", Width: 844, Height: 390},
	}
	for _, motionCase := range cases {
		t.Run(motionCase.Name, func(t *testing.T) {
			corners := []struct {
				name string
				x, y float64
			}{
				{name: "top-left", x: 0, y: 0},
				{name: "top-right", x: motionCase.Width, y: 0},
				{name: "bottom-left", x: 0, y: motionCase.Height},
				{name: "bottom-right", x: motionCase.Width, y: motionCase.Height},
			}
			for _, corner := range corners {
				got := p04SquareContact(1, corner.x, corner.y, motionCase.Width, motionCase.Height)
				wantX := (p04MotionSquareMM-gain*motionCase.Width)/(2*p04MotionSquareMM) + gain*corner.x/p04MotionSquareMM
				wantY := (p04MotionSquareMM-gain*motionCase.Height)/(2*p04MotionSquareMM) + gain*corner.y/p04MotionSquareMM
				if math.Abs(got.X-wantX) > tolerance || math.Abs(got.Y-wantY) > tolerance {
					t.Fatalf("%s: got (%g,%g), want (%g,%g)", corner.name, got.X, got.Y, wantX, wantY)
				}
				if got.X < -tolerance || got.X > 1+tolerance || got.Y < -tolerance || got.Y > 1+tolerance {
					t.Fatalf("%s saturates outside square: (%g,%g)", corner.name, got.X, got.Y)
				}
			}

			topLeft := p04SquareContact(1, 0, 0, motionCase.Width, motionCase.Height)
			topRight := p04SquareContact(1, motionCase.Width, 0, motionCase.Width, motionCase.Height)
			bottomLeft := p04SquareContact(1, 0, motionCase.Height, motionCase.Width, motionCase.Height)
			bottomRight := p04SquareContact(1, motionCase.Width, motionCase.Height, motionCase.Width, motionCase.Height)
			if !(topLeft.X < topRight.X && bottomLeft.X < bottomRight.X && topLeft.Y < bottomLeft.Y && topRight.Y < bottomRight.Y) {
				t.Fatalf("mapper is not monotonic: TL=(%g,%g) TR=(%g,%g) BL=(%g,%g) BR=(%g,%g)",
					topLeft.X, topLeft.Y, topRight.X, topRight.Y, bottomLeft.X, bottomLeft.Y, bottomRight.X, bottomRight.Y)
			}
			shortAxis := "x"
			if motionCase.Height < motionCase.Width {
				shortAxis = "y"
			}
			if shortAxis == "x" {
				if !(topLeft.X > 0 && topRight.X < 1) || math.Abs(topLeft.Y) > tolerance || math.Abs(bottomLeft.Y-1) > tolerance {
					t.Fatalf("portrait edge mapping has wrong centered margin: TL=(%g,%g) BR=(%g,%g)", topLeft.X, topLeft.Y, bottomRight.X, bottomRight.Y)
				}
			} else if !(topLeft.Y > 0 && bottomLeft.Y < 1) || math.Abs(topLeft.X) > tolerance || math.Abs(topRight.X-1) > tolerance {
				t.Fatalf("landscape edge mapping has wrong centered margin: TL=(%g,%g) TR=(%g,%g)", topLeft.X, topLeft.Y, topRight.X, topRight.Y)
			}

			origin := p04SquareContact(1, 0, 0, motionCase.Width, motionCase.Height)
			x100 := p04SquareContact(1, 100, 0, motionCase.Width, motionCase.Height)
			y100 := p04SquareContact(1, 0, 100, motionCase.Width, motionCase.Height)
			if got := (x100.X - origin.X) * p04MotionSquareMM; math.Abs(got-gain*100) > tolerance {
				t.Fatalf("X gain=%g mm, want %g", got, gain*100)
			}
			if got := (y100.Y - origin.Y) * p04MotionSquareMM; math.Abs(got-gain*100) > tolerance {
				t.Fatalf("Y gain=%g mm, want %g", got, gain*100)
			}
		})
	}
}

func TestP04MotionEvidenceRejectsInvalidCopy(t *testing.T) {
	path := os.Getenv("PHONEPAD_P04_MOTION_SUMMARY")
	if path == "" {
		t.Skip("P04 motion evidence analysis is opt-in")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var summary p04MotionSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}
	if len(summary.Cases) == 0 {
		t.Fatal("summary has no cases")
	}
	var report p04MotionReport
	if err := json.Unmarshal(summary.Cases[0], &report); err != nil {
		t.Fatal(err)
	}
	missingStage := p04MotionTraces()[0].Name
	kept := report.Motions[:0]
	for _, motion := range report.Motions {
		if motion.Stage != missingStage {
			kept = append(kept, motion)
		}
	}
	report.Motions = kept
	report.MotionEventCount = len(kept)
	invalid, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	copyFile, err := os.CreateTemp("/tmp", "phonepad-p04-invalid-*.json")
	if err != nil {
		t.Fatal(err)
	}
	copyPath := copyFile.Name()
	t.Cleanup(func() { _ = os.Remove(copyPath) })
	if _, err := copyFile.Write(invalid); err != nil {
		_ = copyFile.Close()
		t.Fatal(err)
	}
	if err := copyFile.Close(); err != nil {
		t.Fatal(err)
	}
	invalidData, err := os.ReadFile(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := analyzeP04MotionReport(invalidData); err == nil {
		t.Fatal("analysis accepted evidence with a missing trace")
	}
}

func analyzeP04MotionSummary(data []byte) ([]p04MotionAnalysis, error) {
	var summary p04MotionSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		return nil, fmt.Errorf("summary JSON: %w", err)
	}
	if len(summary.Cases) == 0 {
		return nil, fmt.Errorf("summary has no cases")
	}
	analyses := make([]p04MotionAnalysis, 0)
	for index, raw := range summary.Cases {
		caseAnalyses, err := analyzeP04MotionReport(raw)
		if err != nil {
			return nil, fmt.Errorf("case %d: %w", index, err)
		}
		analyses = append(analyses, caseAnalyses...)
	}
	return analyses, nil
}

func analyzeP04MotionReport(data []byte) ([]p04MotionAnalysis, error) {
	var report p04MotionReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("report JSON: %w", err)
	}
	if !report.ExclusiveGrab {
		return nil, fmt.Errorf("observer did not hold EVIOCGRAB")
	}
	if report.Acceleration.ProfileChanged {
		return nil, fmt.Errorf("observer changed the acceleration profile")
	}
	if report.MotionEventCount != len(report.Motions) {
		return nil, fmt.Errorf("motionEventCount=%d but recorded %d motions", report.MotionEventCount, len(report.Motions))
	}
	if len(report.Fixture.Traces) != len(p04MotionTraces()) {
		return nil, fmt.Errorf("fixture declares %d traces, want %d", len(report.Fixture.Traces), len(p04MotionTraces()))
	}
	traces := make(map[string]p04MotionTrace, len(report.Fixture.Traces))
	for _, trace := range report.Fixture.Traces {
		if _, exists := traces[trace.Name]; exists {
			return nil, fmt.Errorf("duplicate trace %q", trace.Name)
		}
		traces[trace.Name] = trace
	}
	for _, expected := range p04MotionTraces() {
		actual, ok := traces[expected.Name]
		if !ok {
			return nil, fmt.Errorf("missing declared trace %q", expected.Name)
		}
		if actual.Axis != expected.Axis || actual.Direction != expected.Direction || actual.Speed != expected.Speed {
			return nil, fmt.Errorf("trace %q metadata does not match fixture definition", expected.Name)
		}
	}
	byStage := make(map[string][]p04MotionEvent, len(traces))
	for _, motion := range report.Motions {
		if _, ok := traces[motion.Stage]; !ok {
			return nil, fmt.Errorf("motion belongs to undeclared trace %q", motion.Stage)
		}
		byStage[motion.Stage] = append(byStage[motion.Stage], motion)
	}
	analyses := make([]p04MotionAnalysis, 0, len(traces))
	for _, expected := range p04MotionTraces() {
		motions := byStage[expected.Name]
		if len(motions) == 0 {
			return nil, fmt.Errorf("trace %q has no motion events", expected.Name)
		}
		var axisAccelerated, perpendicularAccelerated, axisRaw, perpendicularRaw float64
		for _, motion := range motions {
			values := []float64{motion.DX, motion.DY, motion.DXUnaccelerated, motion.DYUnaccelerated}
			for _, value := range values {
				if math.IsNaN(value) || math.IsInf(value, 0) {
					return nil, fmt.Errorf("trace %q contains non-finite motion", expected.Name)
				}
			}
			if expected.Axis == "x" {
				axisAccelerated += motion.DX
				perpendicularAccelerated += motion.DY
				axisRaw += motion.DXUnaccelerated
				perpendicularRaw += motion.DYUnaccelerated
			} else {
				axisAccelerated += motion.DY
				perpendicularAccelerated += motion.DX
				axisRaw += motion.DYUnaccelerated
				perpendicularRaw += motion.DXUnaccelerated
			}
		}
		sign := 1.0
		if expected.Direction == "negative" {
			sign = -1
		}
		if sign*axisRaw <= 1e-9 || sign*axisAccelerated <= 1e-9 {
			return nil, fmt.Errorf("trace %q has no expected signed motion: raw=%g accelerated=%g", expected.Name, axisRaw, axisAccelerated)
		}
		if math.Abs(perpendicularRaw) > p04MotionCrossAxisTolerance(axisRaw) ||
			math.Abs(perpendicularAccelerated) > p04MotionCrossAxisTolerance(axisAccelerated) {
			return nil, fmt.Errorf("trace %q has excessive perpendicular motion: raw=%g accelerated=%g", expected.Name, perpendicularRaw, perpendicularAccelerated)
		}
		logicalDistance := math.Abs(expected.End-expected.Start) * report.Fixture.Case.Width
		if expected.Axis == "y" {
			logicalDistance = math.Abs(expected.End-expected.Start) * report.Fixture.Case.Height
		}
		if logicalDistance <= 0 || report.Fixture.Case.Resolution <= 0 {
			return nil, fmt.Errorf("trace %q has invalid logical distance or resolution", expected.Name)
		}
		rawMM := math.Abs(axisRaw) / float64(report.Fixture.Case.Resolution)
		analyses = append(analyses, p04MotionAnalysis{
			Case: report.Fixture.Case.Name, Stage: expected.Name, Axis: expected.Axis, Direction: expected.Direction, Events: len(motions),
			AxisAccelerated: axisAccelerated, PerpendicularAccelerated: perpendicularAccelerated,
			AxisRaw: axisRaw, PerpendicularRaw: perpendicularRaw, RawMM: rawMM,
			MMPerPoint: rawMM / logicalDistance,
		})
	}
	return analyses, nil
}

func p04MotionCrossAxisTolerance(total float64) float64 {
	return math.Max(1, math.Abs(total)*0.01)
}

func p04MotionDevicePath(pad *mtTouchpad) (string, string, error) {
	var name [256]byte
	if err := ioctl(uintptr(pad.fd), 0x8100552c, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		return "", "", err
	}
	sysname := strings.TrimRight(string(name[:]), "\x00")
	var paths []string
	for i := 0; i < 100; i++ {
		paths, _ = filepath.Glob(filepath.Join("/sys/devices/virtual/input", sysname, "event*"))
		if len(paths) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(paths) != 1 {
		return "", "", fmt.Errorf("new virtual event node missing for %s", sysname)
	}
	return sysname, filepath.Join("/dev/input", filepath.Base(paths[0])), nil
}

func p04MotionWaitFor(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for %s", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func p04MotionAxis(mm float64) int32 {
	return int32(math.Round(mm * float64(p04MotionResolution)))
}

func p04SquareContact(id int, x, y, width, height float64) Contact {
	return Contact{
		ID: id,
		X:  (p04MotionSquareMM-p04MotionIsoGain*width)/(2*p04MotionSquareMM) + p04MotionIsoGain*x/p04MotionSquareMM,
		Y:  (p04MotionSquareMM-p04MotionIsoGain*height)/(2*p04MotionSquareMM) + p04MotionIsoGain*y/p04MotionSquareMM,
	}
}

func p04MotionTraces() []p04MotionTrace {
	traces := make([]p04MotionTrace, 0, 8)
	for _, speed := range []struct {
		name  string
		delay time.Duration
	}{{"slow", 20 * time.Millisecond}, {"comfortable", 8 * time.Millisecond}} {
		for _, axis := range []string{"x", "y"} {
			for _, direction := range []string{"positive", "negative"} {
				start, end := 0.10, 0.90
				if direction == "negative" {
					start, end = end, start
				}
				traces = append(traces, p04MotionTrace{
					Name: fmt.Sprintf("%s-%s-%s", axis, direction, speed.name), Axis: axis,
					Direction: direction, Speed: speed.name, DelayMS: int(speed.delay / time.Millisecond),
					Start: start, End: end, Steps: 32,
				})
			}
		}
	}
	return traces
}

func emitP04MotionTrace(pad *mtTouchpad, motionCase p04MotionCase, trace p04MotionTrace) {
	const pauseAfterLift = 120 * time.Millisecond
	delay := time.Duration(trace.DelayMS) * time.Millisecond
	contact := func(value float64, id int) Contact {
		x, y := 0.5, 0.5
		if trace.Axis == "x" {
			x = value
		} else {
			y = value
		}
		if motionCase.Mapper == "current-aspect-fit" {
			return p04CurrentContact(id, x*motionCase.Width, y*motionCase.Height, motionCase.Width, motionCase.Height)
		}
		if motionCase.Mapper == "square-centered" {
			return p04SquareContact(id, x*motionCase.Width, y*motionCase.Height, motionCase.Width, motionCase.Height)
		}
		return Contact{ID: id, X: x, Y: y}
	}
	pad.touch([]Contact{contact(trace.Start, 1)})
	time.Sleep(50 * time.Millisecond)
	for i := 1; i <= trace.Steps; i++ {
		time.Sleep(delay)
		fraction := float64(i) / float64(trace.Steps)
		value := trace.Start + (trace.End-trace.Start)*fraction
		pad.touch([]Contact{contact(value, 1)})
	}
	pad.touch(nil)
	time.Sleep(pauseAfterLift)
}

func p04CurrentContact(id int, x, y, width, height float64) Contact {
	scale := math.Min(100/width, 70/height)
	offsetX := (100 - width*scale) / 2
	offsetY := (70 - height*scale) / 2
	return Contact{ID: id, X: p04Clamp((offsetX + x*scale) / 100), Y: p04Clamp((offsetY + y*scale) / 70)}
}

func p04Clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func writeP04JSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0600)
}
