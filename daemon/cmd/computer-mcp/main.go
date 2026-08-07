// computer-mcp — PROTOTYPE. MCP server que le da a Claude Code "computer use"
// reusando la capa de inyección uinput de phonepad (internal/input). Claude Code
// (plan Max, visión Opus 4.8) consume estas tools: pide screenshot, ve la imagen,
// y llama left_click/type_text/press_key/scroll. Cero créditos de API.
//
// Insight de diseño (resuelve el gap absoluto-vs-relativo Y el límite de 25k tokens):
//   internal/input.NewAbsolute abre un touchpad EV_ABS cuyo rango lógico [0,max]
//   el compositor mapea al área física del monitor. Creamos ese rango = dims de la
//   imagen REDUCIDA que ve Claude. Entonces las coords que Claude da (en píxeles de
//   esa imagen) van directo a MoveTo, sin factor de escala ni estado mutable. Y como
//   la imagen va reducida (~1280px) + JPEG, entra bajo el techo de 25k tokens.
//
// Correr:
//   go build -o bin/computer-mcp ./cmd/computer-mcp && claude mcp add --scope project \
//     --transport stdio phonepad -- /abs/path/bin/computer-mcp
//   go run ./cmd/computer-mcp --repl     # debug manual de la capa de ejecución, sin Claude
//
// Requisitos: /dev/uinput (setup de phonepad) + wtype + una herramienta de captura
// (grim / gnome-screenshot / spectacle / scrot / maim).
package main

import (
	"bufio"
	"bytes"
	"context"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"log"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"phonepad/daemon/internal/input"
)

// config resuelta al arranque. Claude ve y razona en el espacio LÓGICO (la imagen
// que mandamos, logicalW×logicalH) de UN monitor objetivo. El touchpad EV_ABS mapea
// su rango al escritorio FÍSICO completo (bboxW×bboxH); por eso traducimos las coords
// de Claude a físicas con el offset del monitor:
//   physX = offX + x*monW/logicalW ; physY = offY + y*monH/logicalH
type config struct {
	logicalW, logicalH int  // dims de la imagen que ve Claude (recorte del monitor objetivo)
	bboxW, bboxH       int  // escritorio físico completo = rango del touchpad
	offX, offY         int  // posición del monitor objetivo dentro del escritorio
	monW, monH         int  // tamaño físico del monitor objetivo
	jpegQ              int  // calidad JPEG de la captura
	shotAfter          bool // devolver un screenshot tras cada acción (COMPUTER_MCP_SHOT_AFTER_ACTION=1)
}

func main() {
	repl := flag.Bool("repl", false, "modo debug manual de la capa de ejecución (sin Claude)")
	sizeFlag := flag.String("size", "", "forzar resolución física WxH (ej 1920x1080)")
	flag.Parse()

	// stdout es el canal JSON-RPC de MCP: TODO el logging va a stderr.
	log.SetOutput(os.Stderr)

	cfg := resolveConfig(*sizeFlag)
	log.Printf("escritorio %dx%d · monitor objetivo %dx%d @+%d+%d → imagen %dx%d (jpeg q%d)",
		cfg.bboxW, cfg.bboxH, cfg.monW, cfg.monH, cfg.offX, cfg.offY, cfg.logicalW, cfg.logicalH, cfg.jpegQ)

	c := newController(cfg)
	defer c.Close()
	if !c.ok() {
		// No es fatal: screenshot sigue andando; las acciones devolverán un error claro.
		log.Printf("⚠ uinput no disponible: %v", c.err)
		log.Printf("  arreglo: sudo usermod -aG input %s && re-login (o correr este server con sudo)", os.Getenv("USER"))
	} else {
		time.Sleep(500 * time.Millisecond) // que udev registre los devices
	}

	if *repl {
		runREPL(c, cfg)
		return
	}
	runMCP(c, cfg)
}

func resolveConfig(sizeFlag string) config {
	bb, outs := detectScreen(sizeFlag)
	target := pickOutput(outs, bb, os.Getenv("COMPUTER_MCP_OUTPUT"))
	lw, lh := logicalDims(target.w, target.h, envInt("COMPUTER_MCP_WIDTH", 1280))
	if len(outs) > 1 {
		log.Printf("%d monitores detectados; operando en %q (COMPUTER_MCP_OUTPUT para cambiar; =all para todo el escritorio)", len(outs), target.name)
	}
	return config{
		logicalW: lw, logicalH: lh,
		bboxW: bb.w, bboxH: bb.h,
		offX: target.x, offY: target.y, monW: target.w, monH: target.h,
		jpegQ:     envInt("COMPUTER_MCP_JPEG_Q", 60),
		shotAfter: os.Getenv("COMPUTER_MCP_SHOT_AFTER_ACTION") == "1",
	}
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}

// ─────────────────────────── controller: acciones de agente sobre input.AbsInjector ──

// controller traduce las acciones de alto nivel del agente (click en píxel, drag,
// scroll, teclas) a llamadas de internal/input. Si uinput no está disponible,
// err != nil y guard() devuelve un error accionable en vez de actuar.
type controller struct {
	inj input.AbsInjector
	err error
	cfg config
}

func newController(cfg config) *controller {
	inj, err := input.NewAbsolute(cfg.bboxW, cfg.bboxH) // touchpad sobre el escritorio completo
	return &controller{inj: inj, err: err, cfg: cfg}
}

func (c *controller) ok() bool { return c.err == nil }

func (c *controller) Close() {
	if c.inj != nil {
		c.inj.Close()
	}
}

// guard ejecuta fn sólo si uinput está disponible; si no, devuelve un error accionable.
func (c *controller) guard(fn func() string) string {
	if c.err != nil {
		return "ERROR: uinput no disponible (" + c.err.Error() + "). Sumá tu usuario al grupo 'input' y re-logueá, o corré el server con sudo."
	}
	return fn()
}

// moveTo traduce coords lógicas (lo que ve Claude, dentro del monitor objetivo) a
// físicas del escritorio completo y posiciona el cursor. En monitor único el offset
// es 0, así que es una simple reescala lógico→físico.
func (c *controller) moveTo(x, y int) {
	px := c.cfg.offX + x*c.cfg.monW/c.cfg.logicalW
	py := c.cfg.offY + y*c.cfg.monH/c.cfg.logicalH
	c.inj.MoveTo(clamp(px, 0, c.cfg.bboxW), clamp(py, 0, c.cfg.bboxH))
}

func (c *controller) click(x, y int, btn string, times int) {
	c.moveTo(x, y)
	time.Sleep(40 * time.Millisecond)
	for i := 0; i < times; i++ {
		c.inj.Button(btn, true)
		time.Sleep(20 * time.Millisecond)
		c.inj.Button(btn, false)
		time.Sleep(60 * time.Millisecond)
	}
}

func (c *controller) drag(x1, y1, x2, y2 int) {
	c.moveTo(x1, y1)
	time.Sleep(40 * time.Millisecond)
	c.inj.Button("l", true)
	time.Sleep(40 * time.Millisecond)
	c.moveTo(x2, y2)
	time.Sleep(40 * time.Millisecond)
	c.inj.Button("l", false)
}

func (c *controller) scroll(x, y int, dir string, amount int) {
	c.moveTo(x, y)
	if amount <= 0 {
		amount = 3
	}
	dx, dy := scrollDelta(dir, amount)
	c.inj.Scroll(dx, dy)
}

func (c *controller) typeText(s string) { c.inj.Text(s) }

func (c *controller) key(combo string) string {
	mods, key, ok := input.ParseKeyCombo(combo)
	if !ok {
		return "ERROR: combo no soportado: " + combo
	}
	c.inj.Combo(mods, key)
	return "pressed " + combo
}

// ───────────────────────────────────────────────────────────── MCP server ──

func runMCP(c *controller, cfg config) {
	s := mcp.NewServer(&mcp.Implementation{Name: "phonepad-computer", Version: "v0.1.0"}, nil)
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	action := &mcp.ToolAnnotations{OpenWorldHint: boolPtr(true), DestructiveHint: boolPtr(false)}

	mcp.AddTool(s, &mcp.Tool{
		Name: "screenshot",
		Description: fmt.Sprintf("Capture the current screen as a JPEG image (%dx%d px). "+
			"Call this FIRST and whenever you need to see the screen. All click/move/drag "+
			"coordinates are in pixels of THIS image: (0,0) top-left, (%d,%d) bottom-right.",
			cfg.logicalW, cfg.logicalH, cfg.logicalW, cfg.logicalH),
		Annotations: readOnly,
	}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		jpg, err := captureJPEG(cfg)
		if err != nil {
			return errResult("screenshot failed: " + err.Error()), nil, nil
		}
		return &mcp.CallToolResult{Content: []mcp.Content{
			&mcp.ImageContent{Data: jpg, MIMEType: "image/jpeg"}, // bytes crudos; el SDK base64-ea
		}}, nil, nil
	})

	type xy struct {
		X int `json:"x" jsonschema:"x pixel coordinate from the left edge of the screenshot"`
		Y int `json:"y" jsonschema:"y pixel coordinate from the top edge of the screenshot"`
	}
	addAction(s, cfg, "left_click", "Move cursor to (x,y) and left-click. Coordinates are screenshot pixels.", action,
		func(in xy) string { return c.guard(func() string { c.click(in.X, in.Y, "l", 1); return ack("left_click", in.X, in.Y) }) })
	addAction(s, cfg, "right_click", "Move cursor to (x,y) and right-click.", action,
		func(in xy) string { return c.guard(func() string { c.click(in.X, in.Y, "r", 1); return ack("right_click", in.X, in.Y) }) })
	addAction(s, cfg, "double_click", "Move cursor to (x,y) and double-click.", action,
		func(in xy) string { return c.guard(func() string { c.click(in.X, in.Y, "l", 2); return ack("double_click", in.X, in.Y) }) })
	addAction(s, cfg, "mouse_move", "Move the cursor to (x,y) without clicking.", action,
		func(in xy) string { return c.guard(func() string { c.moveTo(in.X, in.Y); return ack("mouse_move", in.X, in.Y) }) })

	addAction(s, cfg, "drag", "Press the left button at (x1,y1), move to (x2,y2), and release. For selecting or dragging.", action,
		func(in struct {
			X1 int `json:"x1" jsonschema:"start x pixel"`
			Y1 int `json:"y1" jsonschema:"start y pixel"`
			X2 int `json:"x2" jsonschema:"end x pixel"`
			Y2 int `json:"y2" jsonschema:"end y pixel"`
		}) string {
			return c.guard(func() string {
				c.drag(in.X1, in.Y1, in.X2, in.Y2)
				return fmt.Sprintf("dragged [%d,%d]→[%d,%d]", in.X1, in.Y1, in.X2, in.Y2)
			})
		})

	addAction(s, cfg, "scroll", "Scroll at (x,y). direction is up|down|left|right; amount is number of wheel notches.", action,
		func(in struct {
			X         int    `json:"x" jsonschema:"x pixel where to scroll"`
			Y         int    `json:"y" jsonschema:"y pixel where to scroll"`
			Direction string `json:"direction" jsonschema:"up, down, left, or right"`
			Amount    int    `json:"amount" jsonschema:"number of wheel notches (default 3)"`
		}) string {
			return c.guard(func() string {
				c.scroll(in.X, in.Y, in.Direction, in.Amount)
				return fmt.Sprintf("scrolled %s x%d at [%d,%d]", in.Direction, in.Amount, in.X, in.Y)
			})
		})

	addAction(s, cfg, "type_text", "Type a Unicode string at the current focus (accents/emoji ok).", action,
		func(in struct {
			Text string `json:"text" jsonschema:"the text to type"`
		}) string {
			return c.guard(func() string { c.typeText(in.Text); return fmt.Sprintf("typed %q", in.Text) })
		})

	addAction(s, cfg, "press_key", "Press a key or combo, e.g. 'Return', 'Escape', 'ctrl+s', 'alt+Tab', 'super+a'.", action,
		func(in struct {
			Combo string `json:"combo" jsonschema:"key or modifier+key combo (e.g. ctrl+c, Return, PageDown)"`
		}) string {
			return c.guard(func() string { return c.key(in.Combo) })
		})

	addAction(s, cfg, "wait", "Wait for the UI to settle before the next screenshot (e.g. just after opening an app or clicking). ms = milliseconds, default 800, max 5000.", readOnly,
		func(in struct {
			Ms int `json:"ms" jsonschema:"milliseconds to wait (default 800, max 5000)"`
		}) string {
			ms := in.Ms
			if ms <= 0 {
				ms = 800
			}
			if ms > 5000 {
				ms = 5000
			}
			time.Sleep(time.Duration(ms) * time.Millisecond)
			return fmt.Sprintf("waited %dms", ms)
		})

	log.Println("computer-mcp listo (stdio). Esperando a Claude Code…")
	if err := s.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("mcp run: %v", err)
	}
}

// addAction registra una tool que ejecuta una acción y devuelve un texto de ack.
// Si cfg.shotAfter está activo y la acción no falló, adjunta un screenshot fresco
// para que Claude vea el efecto sin un round-trip extra.
func addAction[In any](s *mcp.Server, cfg config, name, desc string, ann *mcp.ToolAnnotations, do func(In) string) {
	mcp.AddTool(s, &mcp.Tool{Name: name, Description: desc, Annotations: ann},
		func(_ context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
			msg := do(in)
			content := []mcp.Content{&mcp.TextContent{Text: msg}}
			if cfg.shotAfter && !strings.HasPrefix(msg, "ERROR") {
				if jpg, err := captureJPEG(cfg); err == nil {
					content = append(content, &mcp.ImageContent{Data: jpg, MIMEType: "image/jpeg"})
				}
			}
			return &mcp.CallToolResult{Content: content}, nil, nil
		})
}

func ack(action string, x, y int) string { return fmt.Sprintf("%s at [%d,%d]", action, x, y) }

func errResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg}}}
}

func boolPtr(b bool) *bool { return &b }

// ───────────────────────────────────────────── captura + reescalado ──

// captureJPEG captura la pantalla real y la devuelve como JPEG en el espacio
// lógico (≤ techo de tokens de Claude Code).
func captureJPEG(cfg config) ([]byte, error) {
	src, err := capture()
	if err != nil {
		return nil, err
	}
	src = cropToOutput(src, cfg) // recorta el escritorio completo al monitor objetivo
	small := downscale(src, cfg.logicalW, cfg.logicalH)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: cfg.jpegQ}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// captureTimeout acota cualquier backend: un screenshooter colgado (visto:
// gnome-screenshot bloqueado 13 min bajo Wayland) deja zombis y, peor, retiene
// el grab modal del shell, que hace fallar todo intento posterior con "not allowed".
const captureTimeout = 8 * time.Second

// capture intenta backends de captura en orden; devuelve la imagen decodificada.
// En Wayland el portal xdg-desktop es la vía soportada (gnome-screenshot 41 falla:
// la interfaz D-Bus del shell rechaza llamadas programáticas con "Screenshot is
// not allowed" y el fallback X11 da root 0×0). Los comandos externos quedan de
// fallback para sesiones X11/wlroots.
func capture() (image.Image, error) {
	if img, err := capturePortal(); err == nil {
		return img, nil
	} else {
		log.Printf("portal screenshot no disponible (%v); probando backends de comando", err)
	}
	return captureCommand()
}

// capturePortal usa org.freedesktop.portal.Screenshot. La 1ª vez GNOME puede pedir
// permiso; concedido, queda recordado y la captura es silenciosa (interactive=false).
// El portal escribe en ~/Pictures/Screenshot-N.png y devuelve su URI: lo leemos y
// lo borramos para no acumular archivos.
func capturePortal() (image.Image, error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, fmt.Errorf("session bus: %w", err)
	}
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.portal.Request"),
		dbus.WithMatchMember("Response"),
	); err != nil {
		return nil, fmt.Errorf("addmatch: %w", err)
	}
	sigs := make(chan *dbus.Signal, 4)
	conn.Signal(sigs)
	defer conn.RemoveSignal(sigs)

	obj := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	opts := map[string]dbus.Variant{
		"interactive": dbus.MakeVariant(false),
		"modal":       dbus.MakeVariant(false),
	}
	var handle dbus.ObjectPath
	if err := obj.Call("org.freedesktop.portal.Screenshot.Screenshot", 0, "", opts).Store(&handle); err != nil {
		return nil, fmt.Errorf("call: %w", err)
	}

	deadline := time.After(captureTimeout)
	for {
		select {
		case sig := <-sigs:
			if sig.Path != handle || len(sig.Body) < 2 {
				continue
			}
			code, _ := sig.Body[0].(uint32)
			if code != 0 {
				return nil, fmt.Errorf("portal rechazó/canceló la captura (code=%d)", code)
			}
			results, _ := sig.Body[1].(map[string]dbus.Variant)
			uriV, ok := results["uri"]
			if !ok {
				return nil, fmt.Errorf("portal no devolvió uri")
			}
			path := uriV.Value().(string)
			if u, e := url.Parse(path); e == nil && u.Path != "" {
				path = u.Path
			}
			defer os.Remove(path) // el portal deja el PNG en ~/Pictures; no acumular
			f, e := os.Open(path)
			if e != nil {
				return nil, fmt.Errorf("abrir captura del portal: %w", e)
			}
			img, _, e := image.Decode(f)
			f.Close()
			if e != nil {
				return nil, fmt.Errorf("decodificar captura del portal: %w", e)
			}
			return img, nil
		case <-deadline:
			return nil, fmt.Errorf("timeout esperando respuesta del portal")
		}
	}
}

// captureCommand prueba screenshooters de CLI en orden (X11 / wlroots). Cada uno
// va con timeout y verifica que el archivo se haya escrito: gnome-screenshot puede
// salir con código 0 sin producir imagen, lo que antes daba un "no such file" opaco.
func captureCommand() (image.Image, error) {
	tmp := os.TempDir() + "/computer-mcp-shot.png"
	candidates := [][]string{
		{"grim", "-t", "png", tmp},
		{"gnome-screenshot", "-f", tmp},
		{"spectacle", "-b", "-n", "-o", tmp},
		{"scrot", "-o", tmp},
		{"maim", tmp},
	}
	var lastErr error = fmt.Errorf("ninguna herramienta de captura disponible (portal xdg-desktop / grim / gnome-screenshot / spectacle / scrot / maim)")
	for _, cmd := range candidates {
		if _, e := exec.LookPath(cmd[0]); e != nil {
			continue
		}
		img, e := runCaptureCmd(tmp, cmd)
		if e != nil {
			lastErr = e
			continue
		}
		return img, nil
	}
	return nil, lastErr
}

// runCaptureCmd corre un screenshooter de CLI (con timeout) y carga el archivo que
// debió escribir. Verifica explícitamente que el archivo exista: gnome-screenshot
// puede salir con código 0 sin producir imagen, y antes eso daba un "no such file"
// opaco en lugar de señalar el backend incompatible.
func runCaptureCmd(tmp string, cmd []string) (image.Image, error) {
	_ = os.Remove(tmp)
	ctx, cancel := context.WithTimeout(context.Background(), captureTimeout)
	e := exec.CommandContext(ctx, cmd[0], cmd[1:]...).Run()
	cancel()
	if e != nil {
		return nil, fmt.Errorf("%s: %w", cmd[0], e)
	}
	f, e := os.Open(tmp)
	if e != nil {
		// salió 0 pero no escribió: backend incompatible con esta sesión.
		return nil, fmt.Errorf("%s salió 0 sin producir imagen (backend incompatible con esta sesión: %w)", cmd[0], e)
	}
	img, _, e := image.Decode(f)
	f.Close()
	if e != nil {
		return nil, fmt.Errorf("%s: decodificar: %w", cmd[0], e)
	}
	return img, nil
}

// downscale hace un box-filter en Go puro (sin deps). Suficiente para que Claude vea la UI.
func downscale(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for dy := 0; dy < dstH; dy++ {
		sy0, sy1 := dy*sh/dstH, (dy+1)*sh/dstH
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for dx := 0; dx < dstW; dx++ {
			sx0, sx1 := dx*sw/dstW, (dx+1)*sw/dstW
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var r, g, bl, n uint32
			for yy := sy0; yy < sy1; yy++ {
				for xx := sx0; xx < sx1; xx++ {
					cr, cg, cb, _ := src.At(b.Min.X+xx, b.Min.Y+yy).RGBA()
					r += cr >> 8
					g += cg >> 8
					bl += cb >> 8
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			dst.Set(dx, dy, color.RGBA{uint8(r / n), uint8(g / n), uint8(bl / n), 255})
		}
	}
	return dst
}

// ───────────────────────────────────── modo REPL (debug sin Claude) ──

func runREPL(c *controller, cfg config) {
	fmt.Printf("REPL — coords en espacio lógico %dx%d. Comandos:\n", cfg.logicalW, cfg.logicalH)
	fmt.Println("  move X Y | click X Y | rclick X Y | dbl X Y | drag X1 Y1 X2 Y2")
	fmt.Println("  scroll up|down|left|right N | type <texto> | key <combo> | shot | calibrate | quit")
	sc := bufio.NewScanner(os.Stdin)
	fmt.Print("\n› ")
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) > 0 {
			execREPL(c, cfg, f)
		}
		fmt.Print("› ")
	}
}

func execREPL(c *controller, cfg config, f []string) {
	atoi := func(i int) int {
		if i >= len(f) {
			return 0
		}
		n, _ := strconv.Atoi(f[i])
		return n
	}
	switch f[0] {
	case "quit", "q", "exit":
		os.Exit(0)
	case "move":
		c.moveTo(atoi(1), atoi(2))
	case "click":
		c.click(atoi(1), atoi(2), "l", 1)
	case "rclick":
		c.click(atoi(1), atoi(2), "r", 1)
	case "dbl":
		c.click(atoi(1), atoi(2), "l", 2)
	case "drag":
		c.drag(atoi(1), atoi(2), atoi(3), atoi(4))
	case "scroll":
		c.scroll(cfg.logicalW/2, cfg.logicalH/2, f[1], atoi(2))
	case "type":
		c.typeText(strings.Join(f[1:], " "))
	case "key":
		fmt.Printf("  %s\n", c.key(f[1]))
	case "shot":
		jpg, err := captureJPEG(cfg)
		fmt.Printf("  captura: %d bytes, err=%v\n", len(jpg), err)
	case "calibrate":
		calibrate(c, cfg)
	default:
		fmt.Printf("  ? %s\n", f[0])
	}
}

// calibrate recorre las esquinas y el centro del espacio lógico para verificar a
// ojo el grounding: si el cursor toca cada punto EXACTO, el mapeo es 1:1.
func calibrate(c *controller, cfg config) {
	pts := []struct {
		name string
		x, y int
	}{
		{"sup-izq", 0, 0},
		{"sup-der", cfg.logicalW - 1, 0},
		{"centro", cfg.logicalW / 2, cfg.logicalH / 2},
		{"inf-izq", 0, cfg.logicalH - 1},
		{"inf-der", cfg.logicalW - 1, cfg.logicalH - 1},
	}
	fmt.Println("  mirá el cursor — debería tocar cada punto que nombro:")
	for _, p := range pts {
		fmt.Printf("    → %s (%d,%d)\n", p.name, p.x, p.y)
		c.moveTo(p.x, p.y)
		time.Sleep(900 * time.Millisecond)
	}
	fmt.Println("  si tocó las 4 esquinas y el centro exacto → grounding 1:1 ✓")
}

// ──────────────────────────────────────────────────────────────── helpers ──

func parseSize(s string) (int, int, bool) {
	p := strings.SplitN(strings.TrimSpace(s), "x", 2)
	if len(p) != 2 {
		return 0, 0, false
	}
	w, e1 := strconv.Atoi(p[0])
	h, e2 := strconv.Atoi(p[1])
	if e1 != nil || e2 != nil || w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return w, h, true
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
