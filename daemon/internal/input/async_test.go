package input

import (
	"reflect"
	"testing"
	"time"
)

// --- asyncText: decorator que serializa la inyección de texto en un worker ---
//
// Saca el camino lento (Text → wl-copy + Ctrl+V + sleep) del read loop del
// server: Text() encola y vuelve enseguida; un único worker procesa en orden.

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

var _ Injector = (*fakeInjector)(nil)

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
	a.Close()

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

type cancelRecordingInjector struct{ *fakeInjector }

func (c *cancelRecordingInjector) CancelTouch() {
	c.calls = append(c.calls, call{"CancelTouch", nil})
}

func TestAsyncText_QueuesTouchCancelAfterFrames(t *testing.T) {
	inner := &cancelRecordingInjector{fakeInjector: &fakeInjector{}}
	a := NewAsyncText(inner, 8)
	a.Touch([]Contact{{ID: 4, X: .2, Y: .3}})
	a.CancelTouch()
	a.Touch([]Contact{{ID: 5, X: .8, Y: .7}})
	a.Close()
	want := []call{
		{"Touch", []any{[]Contact{{ID: 4, X: .2, Y: .3}}}},
		{"CancelTouch", nil},
		{"Touch", []any{[]Contact{{ID: 5, X: .8, Y: .7}}}},
		{"Close", nil},
	}
	if !reflect.DeepEqual(inner.calls, want) {
		t.Fatalf("touch cancellation FIFO = %+v, want %+v", inner.calls, want)
	}
}

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

func TestAsyncText_ResetDropsQueuedFrames(t *testing.T) {
	g := &gatedInjector{fakeInjector: &fakeInjector{}, started: make(chan struct{}), release: make(chan struct{})}
	a := NewAsyncText(g, 1)
	a.Text("viejo-1")
	<-g.started
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
