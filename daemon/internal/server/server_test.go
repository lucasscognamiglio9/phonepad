package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"phonepad/daemon/internal/input"
)

// staticAuth es un Authenticator de prueba con un token fijo (Paired=false).
type staticAuth string

func (a staticAuth) Token() string { return string(a) }

func (a staticAuth) Valid(token string) bool { return token == string(a) }
func (a staticAuth) MarkPaired() error       { return nil }
func (a staticAuth) Paired() bool            { return false }

// fakeInjector registra las llamadas para verificar el ruteo de route()
// sin tocar /dev/uinput.
type fakeInjector struct {
	moves    [][2]int
	buttons  []buttonCall
	scrolls  [][2]int
	texts    []string
	specials []string
	combos   []comboCall
	gestures []string
	touches  [][]input.Contact
	cancels  int
}

type buttonCall struct {
	btn  string
	down bool
}
type comboCall struct {
	mods []string
	key  string
}

func (f *fakeInjector) Move(dx, dy int) { f.moves = append(f.moves, [2]int{dx, dy}) }
func (f *fakeInjector) Button(btn string, down bool) {
	f.buttons = append(f.buttons, buttonCall{btn, down})
}
func (f *fakeInjector) Scroll(dx, dy int)  { f.scrolls = append(f.scrolls, [2]int{dx, dy}) }
func (f *fakeInjector) Text(s string)      { f.texts = append(f.texts, s) }
func (f *fakeInjector) Special(key string) { f.specials = append(f.specials, key) }
func (f *fakeInjector) Combo(mods []string, key string) {
	f.combos = append(f.combos, comboCall{mods, key})
}
func (f *fakeInjector) Gesture(name string) { f.gestures = append(f.gestures, name) }
func (f *fakeInjector) Touch(contacts []input.Contact) {
	f.touches = append(f.touches, contacts)
}
func (f *fakeInjector) CancelTouch() { f.cancels++ }
func (f *fakeInjector) Close()       {}

// Garantiza en compilación que el fake implementa la interfaz.
var _ input.Injector = (*fakeInjector)(nil)

type resetProbeInjector struct {
	fakeInjector
	resets atomic.Int32
}

func (p *resetProbeInjector) Reset() { p.resets.Add(1) }

var _ input.Resettable = (*resetProbeInjector)(nil)

// routeMsg corre Parse + route con un conn nil. route solo escribe al conn en
// el caso "ping"; los demás tipos no lo tocan, así que nil es seguro para ellos.
func routeMsg(s *Server, raw string) {
	if m, ok := Parse([]byte(raw)); ok {
		s.route(context.Background(), nil, m)
	}
}

func localRequest(method, target string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.RemoteAddr = "127.0.0.1:1234"
	return r
}

func TestRouteTouch(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"t","c":[{"id":1,"x":0.5,"y":0.25},{"id":2,"x":0.1,"y":0.9}]}`)
	want := [][]input.Contact{{{ID: 1, X: 0.5, Y: 0.25}, {ID: 2, X: 0.1, Y: 0.9}}}
	if !reflect.DeepEqual(f.touches, want) {
		t.Errorf("touches = %v, want %v", f.touches, want)
	}
}

func TestRouteTouchCancel(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"t","c":[],"cancel":true}`)
	if f.cancels != 1 {
		t.Fatalf("cancel count = %d, want 1", f.cancels)
	}
	if len(f.touches) != 0 {
		t.Fatalf("cancel unexpectedly routed as touch snapshot: %v", f.touches)
	}
}

func TestRouteMove(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"m","dx":12,"dy":-4}`)
	if !reflect.DeepEqual(f.moves, [][2]int{{12, -4}}) {
		t.Errorf("moves = %v", f.moves)
	}
}

func TestRouteButton(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"b","a":"down","btn":"l"}`)
	routeMsg(s, `{"t":"b","a":"up","btn":"l"}`)
	want := []buttonCall{{"l", true}, {"l", false}}
	if !reflect.DeepEqual(f.buttons, want) {
		t.Errorf("buttons = %v, want %v", f.buttons, want)
	}
}

func TestRouteScroll(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"s","dx":0,"dy":-3}`)
	if !reflect.DeepEqual(f.scrolls, [][2]int{{0, -3}}) {
		t.Errorf("scrolls = %v", f.scrolls)
	}
}

func TestRouteKeyboard(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"k","a":"text","text":"café 🚀"}`)
	routeMsg(s, `{"t":"k","a":"special","key":"Backspace"}`)
	routeMsg(s, `{"t":"k","a":"combo","mods":["ctrl"],"key":"c"}`)

	if !reflect.DeepEqual(f.texts, []string{"café 🚀"}) {
		t.Errorf("texts = %v", f.texts)
	}
	if !reflect.DeepEqual(f.specials, []string{"Backspace"}) {
		t.Errorf("specials = %v", f.specials)
	}
	if !reflect.DeepEqual(f.combos, []comboCall{{[]string{"ctrl"}, "c"}}) {
		t.Errorf("combos = %v", f.combos)
	}
}

func TestRouteGesture(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	routeMsg(s, `{"t":"g","name":"ws-left"}`)
	routeMsg(s, `{"t":"g","name":"overview"}`)
	if !reflect.DeepEqual(f.gestures, []string{"ws-left", "overview"}) {
		t.Errorf("gestures = %v, want [ws-left overview]", f.gestures)
	}
}

func TestQREndpointEncodesPairURL(t *testing.T) {
	// El QR debe generarse y servirse como SVG válido. No decodificamos el QR,
	// pero verificamos que el endpoint responde un SVG (la URL es la única fuente).
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	req := localRequest(http.MethodGet, "/qr.svg")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("Content-Type = %q, want image/svg+xml", ct)
	}
	if !strings.Contains(w.Body.String(), "<svg") {
		t.Errorf("respuesta no parece SVG: %.40q", w.Body.String())
	}
}

func TestWS_RejectsBadToken(t *testing.T) {
	// La validación del token ocurre ANTES del upgrade: un token inválido
	// responde 401 sin intentar el handshake WS.
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	req := localRequest(http.MethodGet, "/ws?token=wrong")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestPairInfoExposesPaired(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	req := localRequest(http.MethodGet, "/api/pair-info")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if !strings.Contains(w.Body.String(), `"paired":false`) {
		t.Errorf("pair-info sin campo paired; body=%s", w.Body.String())
	}
}

func TestPairInfoJSON(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	req := localRequest(http.MethodGet, "/api/pair-info")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{`"192.168.1.40"`, `8080`, `http://192.168.1.40:8080/`} {
		if !strings.Contains(body, want) {
			t.Errorf("pair-info no contiene %q; body=%s", want, body)
		}
	}
	if strings.Contains(body, "tok") {
		t.Errorf("pair-info filtró token: %s", body)
	}
}

func TestPairingEndpointsRejectLAN(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, fstest.MapFS{"pair.html": {Data: []byte("ok")}}, "https://192.168.1.40:8080/?token=tok")
	for _, path := range []string{"/pair", "/qr.svg", "/api/pair-info", "/events"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "192.168.1.99:4567"
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s status=%d, want 403", path, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/pair-info", nil)
	req.RemoteAddr = ""
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("RemoteAddr vacío status=%d, want 403", rec.Code)
	}
}

func TestAuthPreflight(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "https://192.168.1.40:8080/?token=tok")
	req := localRequest(http.MethodGet, "/api/auth")
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("valid auth status=%d, want 204", rec.Code)
	}
	req = localRequest(http.MethodGet, "/api/auth")
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid auth status=%d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "tok") {
		t.Errorf("auth error filtró credencial: %q", rec.Body.String())
	}
}

func TestWSReadIdleDeadlineResets(t *testing.T) {
	probe := &resetProbeInjector{}
	s := New(staticAuth("tok"), probe, nil, "http://127.0.0.1:8080/?token=tok")
	s.readTimeout = 20 * time.Millisecond
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {sessionCookieName + "=tok"}}})
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer c.CloseNow()
	waitForResetCount(t, probe, 2)
}

func TestWSWatchdogClosesHalfOpenAndResets(t *testing.T) {
	probe := &resetProbeInjector{}
	s := New(staticAuth("tok"), probe, nil, "http://127.0.0.1:8080/?token=tok")
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {sessionCookieName + "=tok"}}})
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer c.CloseNow()

	current := waitForCurrent(t, s)
	if current == nil {
		t.Fatal("server did not register websocket")
	}
	watchCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go s.watchdog(watchCtx, current, time.Millisecond, 5*time.Millisecond)
	waitForResetCount(t, probe, 2)
}

func waitForResetCount(t *testing.T, probe *resetProbeInjector, want int32) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		if probe.resets.Load() >= want {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("Reset count=%d, want at least %d", probe.resets.Load(), want)
		case <-ticker.C:
		}
	}
}

func waitForCurrent(t *testing.T, s *Server) *websocket.Conn {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		current := s.current
		s.mu.Unlock()
		if current != nil {
			return current
		}
		select {
		case <-deadline.C:
			return nil
		case <-ticker.C:
		}
	}
}

func TestEventsSnapshot(t *testing.T) {
	// Al suscribirse, /events emite inmediatamente el snapshot de estado
	// (connected:false sin cliente). Cerramos el request vía contexto cancelado.
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	ctx, cancel := context.WithCancel(context.Background())
	req := localRequest(http.MethodGet, "/events").WithContext(ctx)
	w := httptest.NewRecorder()
	cancel() // el handler escribe el snapshot y luego ve el ctx cancelado
	s.Handler().ServeHTTP(w, req)
	body := w.Body.String()
	if !strings.Contains(body, "event: state") || !strings.Contains(body, `"connected":false`) {
		t.Errorf("snapshot ausente o mal: %q", body)
	}
}

func TestHubConnectDisconnectEvents(t *testing.T) {
	h := newHub()
	ch, snap, cancel := h.subscribe()
	defer cancel()
	if !strings.Contains(string(snap.data), `"connected":false`) {
		t.Errorf("snapshot inicial = %s", snap.data)
	}
	h.clientConnected("Android Chrome")
	ev := <-ch
	if ev.name != "client_connected" || !strings.Contains(string(ev.data), `"connected":true`) || !strings.Contains(string(ev.data), "Android Chrome") {
		t.Errorf("client_connected = %+v", ev)
	}
	h.clientDisconnected()
	ev = <-ch
	if ev.name != "client_disconnected" || !strings.Contains(string(ev.data), `"connected":false`) {
		t.Errorf("client_disconnected = %+v", ev)
	}
}

func TestStaticHandlerDevInject(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body><script src=\"app.js\"></script></body></html>")},
	}
	s := New(staticAuth("tok"), &fakeInjector{}, webFS, "url", WithDevInject())

	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, localRequest("GET", "/"))
	if !strings.Contains(rec.Body.String(), "__PHONEPAD_DEV__") {
		t.Errorf("dev: GET / debe inyectar el flag dev, body=%s", rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("dev: GET / debe ser no-store, got %q", rec.Header().Get("Cache-Control"))
	}

	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, localRequest("GET", "/sw.js"))
	if !strings.Contains(rec.Body.String(), "unregister") {
		t.Errorf("dev: /sw.js debe ser el SW de autodestrucción, body=%s", rec.Body.String())
	}
}

func TestStaticHandlerProdNoInject(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body>hola</body></html>")},
	}
	s := New(staticAuth("tok"), &fakeInjector{}, webFS, "url") // sin WithDevInject

	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, localRequest("GET", "/"))
	if strings.Contains(rec.Body.String(), "__PHONEPAD_DEV__") {
		t.Errorf("prod NO debe inyectar el flag dev, body=%s", rec.Body.String())
	}
}

func TestRouteUnknownAndPingNoInjection(t *testing.T) {
	f := &fakeInjector{}
	s := New(staticAuth("tok"), f, nil, "http://192.168.1.40:8080/?token=tok")
	// Tipo desconocido y un "k" con acción rara: no deben invocar al Injector.
	routeMsg(s, `{"t":"futuro","dx":5}`)
	routeMsg(s, `{"t":"k","a":"raro"}`)
	if len(f.moves)+len(f.buttons)+len(f.scrolls)+len(f.texts)+len(f.specials)+len(f.combos) != 0 {
		t.Errorf("un mensaje desconocido inyectó algo: %+v", f)
	}
}

func TestRejectPublicClientsEvenWithToken(t *testing.T) {
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	for _, remote := range []string{"8.8.8.8:1234", "[2001:4860:4860::8888]:1234"} {
		req := localRequest("GET", "/api/auth")
		req.RemoteAddr = remote
		req.Header.Set("Authorization", "Bearer tok")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("public source %s accepted", remote)
		}
	}
	req := localRequest("GET", "/api/auth")
	req.RemoteAddr = "192.168.1.20:1234"
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("private source rejected: %d", rec.Code)
	}
}
