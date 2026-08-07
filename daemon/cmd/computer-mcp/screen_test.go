package main

import (
	"reflect"
	"testing"
)

const xrandrDual = `Screen 0: minimum 320 x 200, current 3840 x 1080, maximum 16384 x 16384
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 309mm x 173mm
   1920x1080     60.00*+  59.97
HDMI-1 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 530mm x 300mm
   1920x1080     60.00*+
DP-2 disconnected (normal left inverted right x axis y axis)`

func TestParseXrandrOutputs(t *testing.T) {
	outs := parseXrandrOutputs(xrandrDual)
	want := []output{
		{name: "eDP-1", x: 0, y: 0, w: 1920, h: 1080, primary: true},
		{name: "HDMI-1", x: 1920, y: 0, w: 1920, h: 1080, primary: false},
	}
	if !reflect.DeepEqual(outs, want) {
		t.Fatalf("parseXrandrOutputs = %+v, want %+v", outs, want)
	}
	if bb := boundingBox(outs); bb.w != 3840 || bb.h != 1080 {
		t.Errorf("boundingBox = %+v, want {3840 1080}", bb)
	}
}

func TestPickOutput(t *testing.T) {
	outs := parseXrandrOutputs(xrandrDual)
	bb := boundingBox(outs)

	if o := pickOutput(outs, bb, ""); o.name != "eDP-1" {
		t.Errorf(`pickOutput("") = %q, want primary "eDP-1"`, o.name)
	}
	if o := pickOutput(outs, bb, "HDMI-1"); o.name != "HDMI-1" || o.x != 1920 {
		t.Errorf(`pickOutput("HDMI-1") = %+v, want el HDMI con offset 1920`, o)
	}
	if o := pickOutput(outs, bb, "all"); o.w != 3840 || o.h != 1080 || o.x != 0 {
		t.Errorf(`pickOutput("all") = %+v, want todo el escritorio 3840x1080@0`, o)
	}
}

func TestLogicalDims(t *testing.T) {
	cases := []struct {
		w, h, targetW, lw, lh int
	}{
		{1920, 1080, 1280, 1280, 720},  // 16:9 típico
		{2880, 1800, 1280, 1280, 800},  // HiDPI 16:10 → mantiene aspecto
		{1024, 768, 1280, 1024, 768},   // target mayor que la pantalla → no upscalea
		{1366, 768, 1280, 1280, 719},   // aspecto raro, trunca
	}
	for _, c := range cases {
		lw, lh := logicalDims(c.w, c.h, c.targetW)
		if lw != c.lw || lh != c.lh {
			t.Errorf("logicalDims(%d,%d,%d) = (%d,%d), want (%d,%d)", c.w, c.h, c.targetW, lw, lh, c.lw, c.lh)
		}
	}
}
