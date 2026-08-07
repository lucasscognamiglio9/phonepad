package input

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/bendahl/uinput"
)

// --- asyncText: decorator que serializa la inyección de texto en un worker ---
//
// Saca el camino lento (Text → wl-copy + Ctrl+V + sleep) del read loop del
// server: Text() encola y vuelve enseguida; un único worker procesa en orden.

// blockingInjector simula un inner lento (como wl-copy/paste real) para
// verificar que asyncText.Text no bloquea al caller.
type blockingInjector struct {
	*fakeInjector
	delay time.Duration
}

func (b *blockingInjector) Text(s string) {
	time.Sleep(b.delay)
	b.fakeInjector.Text(s)
}

func TestAsyncText_ForwardsInOrder(t *testing.T) {
	fake := &fakeInjector{}
	a := NewAsyncText(fake, 8)
	a.Text("a")
	a.Text("b")
	a.Text("c")
	a.Close() // drena la cola y espera al worker antes de cerrar el inner

	want := []call{
		{"Text", []any{"a"}},
		{"Text", []any{"b"}},
		{"Text", []any{"c"}},
		{"Close", nil},
	}
	if !reflect.DeepEqual(fake.calls, want) {
		t.Errorf("calls = %+v, want %+v", fake.calls, want)
	}
}

func TestAsyncText_DoesNotBlockCaller(t *testing.T) {
	// El inner tarda 50ms por Text; encolar NO debe bloquear al caller (read loop).
	b := &blockingInjector{fakeInjector: &fakeInjector{}, delay: 50 * time.Millisecond}
	a := NewAsyncText(b, 8)
	start := time.Now()
	a.Text("x")
	if elapsed := time.Since(start); elapsed > 15*time.Millisecond {
		t.Errorf("Text() bloqueó %v al caller; debería volver enseguida", elapsed)
	}
	a.Close()
}

func TestAsyncText_SerializesKeyboardAndTouchFIFO(t *testing.T) {
	fake := &fakeInjector{}
	a := NewAsyncText(fake, 8)
	a.Text("texto")
	a.Special("Enter")
	a.Combo([]string{"ctrl"}, "c")
	a.Touch([]Contact{{ID: 7, X: .5, Y: .5}})
	a.Close()

	want := []call{
		{"Text", []any{"texto"}},
		{"Special", []any{"Enter"}},
		{"Combo", []any{[]string{"ctrl"}, "c"}},
		{"Touch", []any{[]Contact{{ID: 7, X: .5, Y: .5}}}},
		{"Close", nil},
	}
	if !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("FIFO calls = %+v, want %+v", fake.calls, want)
	}
}

func TestAsyncText_ResetDropsQueuedFrames(t *testing.T) {
	g := &gatedInjector{fakeInjector: &fakeInjector{}, started: make(chan struct{}), release: make(chan struct{})}
	a := NewAsyncText(g, 1)
	a.Text("viejo-1")
	<-g.started // primer op en vuelo; el segundo queda en la FIFO
	a.Text("viejo-2")
	done := make(chan struct{})
	go func() { a.Reset(); close(done) }()
	for deadline := time.Now().Add(time.Second); a.(*asyncText).epoch.Load() == 0 && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	if a.(*asyncText).epoch.Load() == 0 {
		t.Fatal("Reset no inició")
	}
	close(g.release)
	<-done
	a.Special("Escape")
	a.Close()

	if len(g.calls) == 0 || g.calls[len(g.calls)-1].method != "Close" {
		t.Fatalf("Close ausente: %+v", g.calls)
	}
	for _, c := range g.calls {
		if c.method == "Text" && c.args[0].(string) == "viejo-2" {
			t.Fatalf("frame viejo sobrevivió Reset: %+v", g.calls)
		}
	}
}

func TestKeyboardStateRemainsReleasableAfterVendorFailures(t *testing.T) {
	k := &recordingKeyboard{failDown: true}
	d := &uinputDevice{kbd: k, held: make(map[int]struct{}), btns: make(map[string]bool)}
	d.keyDown(uinput.KeyA)
	if _, ok := d.held[uinput.KeyA]; !ok {
		t.Fatal("KeyDown incierto no quedó marcado para release")
	}
	k.failDown = false
	d.keyUp(uinput.KeyA)
	k.failPress = true
	d.keyPress(uinput.KeyA)
	if _, ok := d.held[uinput.KeyA]; !ok {
		t.Fatal("KeyPress incierto no quedó marcado para release")
	}
	k.failPress = false
	d.keyUp(uinput.KeyA)
	d.keyDown(uinput.KeyA)
	k.failUp = true
	d.keyUp(uinput.KeyA)
	if _, ok := d.held[uinput.KeyA]; !ok {
		t.Fatal("KeyUp incierto olvidó una tecla held")
	}
	k.failUp = false
	d.keyUp(uinput.KeyA)
	if _, ok := d.held[uinput.KeyA]; ok {
		t.Fatal("KeyUp confirmado dejó la tecla held")
	}
}

func TestMouseStateRemainsReleasableAfterVendorFailures(t *testing.T) {
	m := &recordingMouse{failPress: true}
	d := &uinputDevice{mouse: m, btns: make(map[string]bool)}
	d.Button("l", true)
	if !d.btns["l"] {
		t.Fatal("LeftPress incierto no quedó marcado para release")
	}
	m.failPress = false
	d.Button("l", true)
	m.failRelease = true
	d.Button("l", false)
	if !d.btns["l"] {
		t.Fatal("LeftRelease fallido olvidó un botón held")
	}
	d.Reset()
	if !d.btns["l"] {
		t.Fatal("Reset fallido olvidó un botón held")
	}
	m.failRelease = false
	d.Reset()
	if d.btns["l"] {
		t.Fatal("release confirmado dejó el botón held")
	}
}

type recordingKeyboard struct {
	failDown  bool
	failUp    bool
	failPress bool
}

func (k *recordingKeyboard) KeyPress(int) error {
	if k.failPress {
		return errors.New("press sync failed")
	}
	return nil
}
func (k *recordingKeyboard) KeyDown(int) error {
	if k.failDown {
		return errors.New("down failed")
	}
	return nil
}
func (k *recordingKeyboard) KeyUp(int) error {
	if k.failUp {
		return errors.New("up failed")
	}
	return nil
}
func (k *recordingKeyboard) FetchSyspath() (string, error) { return "", nil }
func (k *recordingKeyboard) Close() error                  { return nil }

var _ uinput.Keyboard = (*recordingKeyboard)(nil)

type recordingMouse struct {
	failPress   bool
	failRelease bool
}

func (m *recordingMouse) MoveLeft(int32) error          { return nil }
func (m *recordingMouse) MoveRight(int32) error         { return nil }
func (m *recordingMouse) MoveUp(int32) error            { return nil }
func (m *recordingMouse) MoveDown(int32) error          { return nil }
func (m *recordingMouse) Move(int32, int32) error       { return nil }
func (m *recordingMouse) LeftClick() error              { return nil }
func (m *recordingMouse) RightClick() error             { return nil }
func (m *recordingMouse) MiddleClick() error            { return nil }
func (m *recordingMouse) LeftPress() error              { return mouseResult(m.failPress) }
func (m *recordingMouse) LeftRelease() error            { return mouseResult(m.failRelease) }
func (m *recordingMouse) RightPress() error             { return nil }
func (m *recordingMouse) RightRelease() error           { return nil }
func (m *recordingMouse) MiddlePress() error            { return nil }
func (m *recordingMouse) MiddleRelease() error          { return nil }
func (m *recordingMouse) Wheel(bool, int32) error       { return nil }
func (m *recordingMouse) FetchSyspath() (string, error) { return "", nil }
func (m *recordingMouse) Close() error                  { return nil }
func mouseResult(fail bool) error {
	if fail {
		return errors.New("mouse write failed")
	}
	return nil
}

var _ uinput.Mouse = (*recordingMouse)(nil)

type gatedInjector struct {
	*fakeInjector
	started chan struct{}
	release chan struct{}
}

func (g *gatedInjector) Text(s string) {
	if s == "viejo-1" {
		close(g.started)
		<-g.release
	}
	g.fakeInjector.Text(s)
}

// --- Tests del mapeo puro (sin hardware) ---
//
// Estos validan la lógica de §4 que NO depende de /dev/uinput: la traducción
// de runes a keycodes y de nombres del protocolo a constantes KEY_*.

func TestRuneToKey_ASCIINoShift(t *testing.T) {
	cases := []struct {
		r    rune
		code int
	}{
		{'a', uinput.KeyA},
		{'z', uinput.KeyZ},
		{'0', uinput.Key0},
		{'9', uinput.Key9},
		{' ', uinput.KeySpace},
		{'-', uinput.KeyMinus},
		{'/', uinput.KeySlash},
		{'.', uinput.KeyDot},
		{'\n', uinput.KeyEnter},
		{'\t', uinput.KeyTab},
	}
	for _, c := range cases {
		code, shift, ok := runeToKey(c.r)
		if !ok || shift || code != c.code {
			t.Errorf("runeToKey(%q) = (%d,%v,%v), want (%d,false,true)", c.r, code, shift, ok, c.code)
		}
	}
}

func TestRuneToKey_ASCIIShift(t *testing.T) {
	cases := []struct {
		r    rune
		code int
	}{
		{'A', uinput.KeyA},
		{'Z', uinput.KeyZ},
		{'!', uinput.Key1},
		{')', uinput.Key0},
		{'?', uinput.KeySlash},
		{':', uinput.KeySemicolon},
		{'_', uinput.KeyMinus},
	}
	for _, c := range cases {
		code, shift, ok := runeToKey(c.r)
		if !ok || !shift || code != c.code {
			t.Errorf("runeToKey(%q) = (%d,%v,%v), want (%d,true,true)", c.r, code, shift, ok, c.code)
		}
	}
}

func TestRuneToKey_UnicodeLimit(t *testing.T) {
	// runeToKey cubre solo ASCII del layout US. Lo usan Combo (atajos con char,
	// p.ej. Ctrl+C) y planText para decidir qué runes van por keycode; las que
	// devuelve ok=false (acentos/ñ/emoji) las pega planText por portapapeles.
	// Este test fija ese límite del layout US.
	for _, r := range []rune{'á', 'é', 'ñ', 'ü', '🚀', '€'} {
		if _, _, ok := runeToKey(r); ok {
			t.Errorf("runeToKey(%q) ok=true, pero el camino de combos solo cubre ASCII US", r)
		}
	}
}

// --- planText: descompone un string en la secuencia de operaciones de tipeo ---
//
// El camino de texto en GNOME Wayland NO puede usar wtype (el compositor no
// implementa zwp_virtual_keyboard_v1). En su lugar, el ASCII del layout US se
// emite por keycode uinput (reusando runeToKey) y el Unicode (acentos/ñ/emoji)
// se inyecta por clipboard-paste. planText decide qué va por cada camino.

func TestPlanText_PureASCII(t *testing.T) {
	got := planText("hi")
	want := []textOp{
		{code: uinput.KeyH},
		{code: uinput.KeyI},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("planText(%q) = %+v, want %+v", "hi", got, want)
	}
}

func TestPlanText_ASCIIShift(t *testing.T) {
	got := planText("Hi!")
	want := []textOp{
		{code: uinput.KeyH, shift: true},
		{code: uinput.KeyI},
		{code: uinput.Key1, shift: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("planText(%q) = %+v, want %+v", "Hi!", got, want)
	}
}

func TestPlanText_NonASCIIPastes(t *testing.T) {
	// "café": c,a,f por keycode; é por paste (no está en el layout US).
	got := planText("café")
	want := []textOp{
		{code: uinput.KeyC},
		{code: uinput.KeyA},
		{code: uinput.KeyF},
		{paste: "é"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("planText(%q) = %+v, want %+v", "café", got, want)
	}
}

func TestPlanText_GroupsContiguousNonASCII(t *testing.T) {
	// Tres runes no-ASCII seguidas (acento, ñ, emoji) → UN solo paste, para no
	// clobberear el portapapeles tres veces.
	got := planText("áñ🚀")
	want := []textOp{
		{paste: "áñ🚀"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("planText(%q) = %+v, want %+v", "áñ🚀", got, want)
	}
}

func TestPlanText_MixedRealistic(t *testing.T) {
	// "café 🚀": el espacio (ASCII) corta la corrida y obliga a dos pastes.
	got := planText("café 🚀")
	want := []textOp{
		{code: uinput.KeyC},
		{code: uinput.KeyA},
		{code: uinput.KeyF},
		{paste: "é"},
		{code: uinput.KeySpace},
		{paste: "🚀"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("planText(%q) = %+v, want %+v", "café 🚀", got, want)
	}
}

func TestPlanText_Empty(t *testing.T) {
	if got := planText(""); got != nil {
		t.Errorf("planText(%q) = %+v, want nil", "", got)
	}
}

func TestSpecialKeysCoverage(t *testing.T) {
	// Las 13 teclas especiales del protocolo (SPEC §3) más "Super" (habilita el
	// gesto overview vía Combo) deben estar mapeadas.
	want := []string{
		"Backspace", "Enter", "Tab", "Escape",
		"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
		"Delete", "Home", "End", "PageUp", "PageDown",
		"Super",
	}
	for _, k := range want {
		if _, ok := specialKeys[k]; !ok {
			t.Errorf("specialKeys[%q] ausente", k)
		}
	}
	if len(specialKeys) != len(want) {
		t.Errorf("specialKeys tiene %d entradas, esperaba %d", len(specialKeys), len(want))
	}
}

func TestGestureCombos(t *testing.T) {
	// Los gestos de 3 dedos deben mapear a combos resolubles por el camino de
	// Combo: la key tiene que ser una tecla especial (Super, ArrowLeft/Right) o
	// un solo carácter resoluble por runeToKey (ej. "a" en Super+A) — exactamente
	// las dos vías que Combo intenta.
	for name, g := range gestureCombos {
		if !comboResolvesKey(g.key) {
			t.Errorf("gesto %q usa key %q que Combo no sabe resolver", name, g.key)
		}
		for _, m := range g.mods {
			if _, ok := modKeys[m]; !ok {
				t.Errorf("gesto %q usa mod %q ausente de modKeys", name, m)
			}
		}
	}
	// Mapeo concreto esperado (SPEC §4).
	if g := gestureCombos["ws-left"]; !reflect.DeepEqual(g.mods, []string{"ctrl", "alt"}) || g.key != "ArrowLeft" {
		t.Errorf("ws-left = %+v, want ctrl+alt+ArrowLeft", g)
	}
	if g := gestureCombos["overview"]; g.mods != nil || g.key != "Super" {
		t.Errorf("overview = %+v, want Super sin mods", g)
	}
	if g := gestureCombos["apps"]; !reflect.DeepEqual(g.mods, []string{"super"}) || g.key != "a" {
		t.Errorf("apps = %+v, want super+a", g)
	}
	// Legacy zoom names stay mapped for old clients; the current PWA sends raw
	// Touch frames and libinput delivers pinch to the active application.
	if g := gestureCombos["zoom-in"]; !reflect.DeepEqual(g.mods, []string{"alt", "super"}) || g.key != "=" {
		t.Errorf("zoom-in = %+v, want alt+super+=", g)
	}
	if g := gestureCombos["zoom-out"]; !reflect.DeepEqual(g.mods, []string{"alt", "super"}) || g.key != "-" {
		t.Errorf("zoom-out = %+v, want alt+super+-", g)
	}
}

// comboResolvesKey espeja la resolución de tecla de Combo: especial o un único
// carácter resoluble por runeToKey.
func comboResolvesKey(key string) bool {
	if _, ok := specialKeys[key]; ok {
		return true
	}
	if r := []rune(key); len(r) == 1 {
		if _, _, ok := runeToKey(r[0]); ok {
			return true
		}
	}
	return false
}

func TestModKeysCoverage(t *testing.T) {
	want := map[string]int{
		"ctrl":  uinput.KeyLeftctrl,
		"alt":   uinput.KeyLeftalt,
		"super": uinput.KeyLeftmeta,
		"shift": uinput.KeyLeftshift,
	}
	if !reflect.DeepEqual(modKeys, want) {
		t.Errorf("modKeys = %v, want %v", modKeys, want)
	}
}

// --- ParseKeyCombo: traducción del atajo de un agente a (mods, key) ---

func TestParseKeyCombo_ModifierPlusChar(t *testing.T) {
	mods, key, ok := ParseKeyCombo("ctrl+s")
	if !ok || key != "s" || !reflect.DeepEqual(mods, []string{"ctrl"}) {
		t.Fatalf(`ParseKeyCombo("ctrl+s") = (%v, %q, %v), want ([ctrl], "s", true)`, mods, key, ok)
	}
}

func TestParseKeyCombo_NormalizesSpecialKeys(t *testing.T) {
	cases := map[string]string{
		"Return": "Enter", "Enter": "Enter", "Escape": "Escape", "esc": "Escape",
		"Up": "ArrowUp", "ArrowDown": "ArrowDown", "PageDown": "PageDown",
		"Page_Up": "PageUp", "space": " ",
	}
	for in, want := range cases {
		mods, key, ok := ParseKeyCombo(in)
		if !ok || len(mods) != 0 || key != want {
			t.Errorf("ParseKeyCombo(%q) = (%v, %q, %v), want ([], %q, true)", in, mods, key, ok, want)
		}
	}
}

func TestParseKeyCombo_CombosAndAliases(t *testing.T) {
	cases := []struct {
		in   string
		mods []string
		key  string
	}{
		{"alt+Tab", []string{"alt"}, "Tab"},
		{"cmd+a", []string{"super"}, "a"}, // cmd → super
		{"ctrl+shift+Escape", []string{"ctrl", "shift"}, "Escape"},
		{"super", nil, "Super"}, // tecla suelta
	}
	for _, c := range cases {
		mods, key, ok := ParseKeyCombo(c.in)
		if !ok || key != c.key || !reflect.DeepEqual(mods, c.mods) {
			t.Errorf("ParseKeyCombo(%q) = (%v, %q, %v), want (%v, %q, true)", c.in, mods, key, ok, c.mods, c.key)
		}
	}
}

func TestParseKeyCombo_RejectsUnknown(t *testing.T) {
	// teclas/mods desconocidos, y un char que runeToKey no resuelve (fuera de US).
	for _, in := range []string{"frobnicate", "hyper+x", "ctrl+wat", "ñ"} {
		if _, _, ok := ParseKeyCombo(in); ok {
			t.Errorf("ParseKeyCombo(%q) ok=true, want false", in)
		}
	}
}

// Ata la traducción al vocabulario canónico: toda key "con nombre" que produce
// ParseKeyCombo debe existir en specialKeys (si no, Combo no sabría ejecutarla).
func TestParseKeyCombo_KeysAreCanonical(t *testing.T) {
	for _, in := range []string{"Return", "Escape", "Tab", "Up", "Down", "PageDown", "PageUp", "Home", "End", "Delete", "Backspace", "super"} {
		_, key, ok := ParseKeyCombo(in)
		if !ok {
			t.Fatalf("ParseKeyCombo(%q) ok=false", in)
		}
		if _, found := specialKeys[key]; !found {
			t.Errorf("ParseKeyCombo(%q) → key %q ausente de specialKeys", in, key)
		}
	}
}

// --- Fake Injector: registra llamadas en vez de tocar hardware ---
//
// Permite testear ruteo/secuencia de acciones sin /dev/uinput. Se exporta el
// patrón acá; el server lo usa para sus propios tests de ruteo.

type call struct {
	method string
	args   []any
}

type fakeInjector struct{ calls []call }

func (f *fakeInjector) Move(dx, dy int) { f.calls = append(f.calls, call{"Move", []any{dx, dy}}) }
func (f *fakeInjector) Button(btn string, down bool) {
	f.calls = append(f.calls, call{"Button", []any{btn, down}})
}
func (f *fakeInjector) Scroll(dx, dy int)  { f.calls = append(f.calls, call{"Scroll", []any{dx, dy}}) }
func (f *fakeInjector) Text(s string)      { f.calls = append(f.calls, call{"Text", []any{s}}) }
func (f *fakeInjector) Special(key string) { f.calls = append(f.calls, call{"Special", []any{key}}) }
func (f *fakeInjector) Combo(mods []string, key string) {
	f.calls = append(f.calls, call{"Combo", []any{mods, key}})
}
func (f *fakeInjector) Gesture(name string) { f.calls = append(f.calls, call{"Gesture", []any{name}}) }
func (f *fakeInjector) Touch(contacts []Contact) {
	f.calls = append(f.calls, call{"Touch", []any{contacts}})
}
func (f *fakeInjector) Close() { f.calls = append(f.calls, call{"Close", nil}) }

// Garantiza en tiempo de compilación que el fake implementa la interfaz.
var _ Injector = (*fakeInjector)(nil)

// Y que la implementación real cumple ambas interfaces (relativa y absoluta).
var (
	_ Injector    = (*uinputDevice)(nil)
	_ AbsInjector = (*uinputDevice)(nil)
)

func TestFakeInjectorRecordsCalls(t *testing.T) {
	f := &fakeInjector{}
	f.Move(12, -4)
	f.Button("l", true)
	f.Button("l", false)
	f.Scroll(0, -3)
	f.Text("hi")
	f.Special("Enter")
	f.Combo([]string{"ctrl"}, "c")

	want := []call{
		{"Move", []any{12, -4}},
		{"Button", []any{"l", true}},
		{"Button", []any{"l", false}},
		{"Scroll", []any{0, -3}},
		{"Text", []any{"hi"}},
		{"Special", []any{"Enter"}},
		{"Combo", []any{[]string{"ctrl"}, "c"}},
	}
	if !reflect.DeepEqual(f.calls, want) {
		t.Errorf("calls = %+v, want %+v", f.calls, want)
	}
}
