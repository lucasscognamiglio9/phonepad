package main

import (
	"image"
	"os/exec"
	"strconv"
	"strings"
)

// box es un tamaño en píxeles.
type box struct{ w, h int }

// output es un monitor: su tamaño y su posición dentro del escritorio (bounding box).
type output struct {
	name       string
	x, y, w, h int
	primary    bool
}

// logicalDims escala (w,h) a un ancho objetivo manteniendo el aspecto, sin
// upscalear si el monitor ya es más chico que el objetivo.
func logicalDims(w, h, targetW int) (int, int) {
	if targetW > w {
		targetW = w
	}
	return targetW, h * targetW / w
}

// detectScreen devuelve el bounding box del escritorio y la lista de monitores.
// Orden: 1) flag --size (un monitor único forzado), 2) xrandr (geometría con
// offsets, también bajo Xwayland), 3) una captura real (un monitor sin offset),
// 4) default. El touchpad EV_ABS mapea su rango a este bounding box completo.
func detectScreen(sizeFlag string) (box, []output) {
	if sizeFlag != "" {
		if w, h, ok := parseSize(sizeFlag); ok {
			return box{w, h}, []output{{name: "forced", w: w, h: h, primary: true}}
		}
	}
	if out, err := exec.Command("xrandr", "--current").Output(); err == nil {
		if outs := parseXrandrOutputs(string(out)); len(outs) > 0 {
			return boundingBox(outs), outs
		}
	}
	if img, err := capture(); err == nil {
		b := img.Bounds()
		return box{b.Dx(), b.Dy()}, []output{{name: "screen", w: b.Dx(), h: b.Dy(), primary: true}}
	}
	return box{1920, 1080}, []output{{name: "default", w: 1920, h: 1080, primary: true}}
}

// parseXrandrOutputs extrae los monitores conectados de la salida de `xrandr`.
// Cada línea de un output conectado luce: "eDP-1 connected primary 1920x1080+0+0 ...".
func parseXrandrOutputs(xr string) []output {
	var outs []output
	for _, line := range strings.Split(xr, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "connected" { // "disconnected" se descarta
			continue
		}
		o := output{name: f[0]}
		var geom string
		for _, tok := range f[2:] {
			if tok == "primary" {
				o.primary = true
				continue
			}
			if isGeom(tok) {
				geom = tok
				break
			}
		}
		if g, ok := parseGeom(geom); ok {
			o.x, o.y, o.w, o.h = g.x, g.y, g.w, g.h
			outs = append(outs, o)
		}
	}
	return outs
}

// isGeom reconoce un token "WxH+X+Y".
func isGeom(s string) bool {
	return strings.Contains(s, "x") && strings.Count(s, "+") == 2
}

// parseGeom interpreta "1920x1080+1920+0" → x,y,w,h.
func parseGeom(s string) (output, bool) {
	plus := strings.Split(s, "+")
	if len(plus) != 3 {
		return output{}, false
	}
	w, h, ok := parseSize(plus[0])
	if !ok {
		return output{}, false
	}
	x, errx := strconv.Atoi(plus[1])
	y, erry := strconv.Atoi(plus[2])
	if errx != nil || erry != nil {
		return output{}, false
	}
	return output{x: x, y: y, w: w, h: h}, true
}

// boundingBox calcula el rectángulo que cubre todos los outputs (desde 0,0).
func boundingBox(outs []output) box {
	var w, h int
	for _, o := range outs {
		if o.x+o.w > w {
			w = o.x + o.w
		}
		if o.y+o.h > h {
			h = o.y + o.h
		}
	}
	return box{w, h}
}

// pickOutput elige el monitor en el que operar según sel:
//   "all"            → todo el escritorio (un output sintético que cubre el bbox)
//   "<nombre>"       → el monitor con ese nombre
//   "" | "primary"   → el monitor marcado primary; si no hay, el de offset (0,0); si no, el 1º
func pickOutput(outs []output, bb box, sel string) output {
	switch sel {
	case "all":
		return output{name: "all", w: bb.w, h: bb.h, primary: true}
	case "", "primary":
		for _, o := range outs {
			if o.primary {
				return o
			}
		}
		for _, o := range outs {
			if o.x == 0 && o.y == 0 {
				return o
			}
		}
	default:
		for _, o := range outs {
			if o.name == sel {
				return o
			}
		}
	}
	if len(outs) > 0 {
		return outs[0]
	}
	return output{name: "all", w: bb.w, h: bb.h, primary: true}
}

// cropToOutput recorta la captura del escritorio completo al rectángulo del monitor
// objetivo. Escala el rectángulo al tamaño REAL de la captura (que puede diferir del
// bbox por scaling), de modo que el recorte cae bien aunque haya HiDPI.
func cropToOutput(src image.Image, cfg config) image.Image {
	if cfg.bboxW == 0 || cfg.bboxH == 0 {
		return src
	}
	b := src.Bounds()
	rx := func(v int) int { return b.Min.X + v*b.Dx()/cfg.bboxW }
	ry := func(v int) int { return b.Min.Y + v*b.Dy()/cfg.bboxH }
	r := image.Rect(rx(cfg.offX), ry(cfg.offY), rx(cfg.offX+cfg.monW), ry(cfg.offY+cfg.monH))
	if sub, ok := src.(interface {
		SubImage(image.Rectangle) image.Image
	}); ok {
		return sub.SubImage(r)
	}
	return src
}
