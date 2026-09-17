package input

import (
	"context"
	"reflect"
	"testing"
)

type literalRecorder struct{ *fakeInjector }

func (r *literalRecorder) LiteralFocus(context.Context) LiteralResult {
	r.calls = append(r.calls, call{"Focus", nil})
	return LiteralResult{State: "ready", Target: "target"}
}
func (r *literalRecorder) LiteralText(_ context.Context, text, target string) LiteralResult {
	r.calls = append(r.calls, call{"Literal", []any{text, target}})
	return LiteralResult{State: "dispatched"}
}
func TestLiteralUsesKeyboardFIFO(t *testing.T) {
	r := &literalRecorder{&fakeInjector{}}
	a := NewAsyncText(r, 4)
	a.Special("Tab")
	literal := a.(LiteralInjector)
	if result := literal.LiteralFocus(context.Background()); result.State != "ready" {
		t.Fatal(result)
	}
	if result := literal.LiteralText(context.Background(), "¿_👨‍👩‍👧‍👦", "target"); result.State != "dispatched" {
		t.Fatal(result)
	}
	a.Special("Enter")
	a.Close()
	want := []call{{"Special", []any{"Tab"}}, {"Focus", nil}, {"Literal", []any{"¿_👨‍👩‍👧‍👦", "target"}}, {"Special", []any{"Enter"}}, {"Close", nil}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Fatal(r.calls)
	}
}
func TestLiteralCancelledOrClosedDoesNotEdit(t *testing.T) {
	r := &literalRecorder{&fakeInjector{}}
	a := NewAsyncText(r, 1)
	literal := a.(LiteralInjector)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := literal.LiteralText(ctx, "text", "target")
	if result.State == "dispatched" {
		t.Fatal(result)
	}
	a.Close()
	if result := literal.LiteralText(context.Background(), "text", "target"); result.State != "rejected" {
		t.Fatal(result)
	}
	if !reflect.DeepEqual(r.calls, []call{{"Close", nil}}) {
		t.Fatal(r.calls)
	}
}
