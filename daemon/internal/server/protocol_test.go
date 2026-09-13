package server

import (
	"reflect"
	"testing"

	"phonepad/daemon/internal/input"
)

func TestParseTouch(t *testing.T) {
	got, ok := Parse([]byte(`{"t":"t","c":[{"id":1,"x":0.5,"y":0.25},{"id":2,"x":0.1,"y":0.9}]}`))
	if !ok {
		t.Fatal("Parse de touch frame ok=false, esperaba true")
	}
	want := Msg{Type: "t", Touches: []input.Contact{{ID: 1, X: 0.5, Y: 0.25}, {ID: 2, X: 0.1, Y: 0.9}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Parse(touch) = %+v, want %+v", got, want)
	}
}

func TestParseTouchCancelRequiresEmptySnapshot(t *testing.T) {
	got, ok := Parse([]byte(`{"t":"t","c":[],"cancel":true}`))
	if !ok || !got.Cancel || len(got.Touches) != 0 {
		t.Fatalf("cancel parse = (%+v, %t), want empty canceled touch", got, ok)
	}
	for _, raw := range []string{
		`{"t":"t","c":[{"id":1,"x":0.5,"y":0.5}],"cancel":true}`,
		`{"t":"t","cancel":true}`,
		`{"t":"t","c":null,"cancel":true}`,
		`{"t":"m","dx":0,"dy":0,"cancel":true}`,
	} {
		if _, ok := Parse([]byte(raw)); ok {
			t.Errorf("Parse(%s) ok=true, want strict cancel rejection", raw)
		}
	}
}

func TestParseValid(t *testing.T) {
	tests := []struct {
		name string
		json string
		want Msg
	}{
		{
			"move",
			`{"t":"m","dx":12,"dy":-4}`,
			Msg{Type: "m", Dx: 12, Dy: -4},
		},
		{
			"button down",
			`{"t":"b","a":"down","btn":"l"}`,
			Msg{Type: "b", Action: "down", Button: "l"},
		},
		{
			"button up",
			`{"t":"b","a":"up","btn":"r"}`,
			Msg{Type: "b", Action: "up", Button: "r"},
		},
		{
			"scroll",
			`{"t":"s","dx":0,"dy":-3}`,
			Msg{Type: "s", Dx: 0, Dy: -3},
		},
		{
			"key text unicode",
			`{"t":"k","a":"text","text":"café 🚀"}`,
			Msg{Type: "k", Action: "text", Text: "café 🚀"},
		},
		{
			"key special",
			`{"t":"k","a":"special","key":"Backspace"}`,
			Msg{Type: "k", Action: "special", Key: "Backspace"},
		},
		{
			"key combo ctrl+c",
			`{"t":"k","a":"combo","mods":["ctrl"],"key":"c"}`,
			Msg{Type: "k", Action: "combo", Mods: []string{"ctrl"}, Key: "c"},
		},
		{
			"key combo alt+tab",
			`{"t":"k","a":"combo","mods":["alt"],"key":"Tab"}`,
			Msg{Type: "k", Action: "combo", Mods: []string{"alt"}, Key: "Tab"},
		},
		{
			"ping",
			`{"t":"ping"}`,
			Msg{Type: "ping"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Parse([]byte(tt.json))
			if !ok {
				t.Fatalf("Parse(%s) ok=false, esperaba true", tt.json)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Parse(%s) = %+v, want %+v", tt.json, got, tt.want)
			}
		})
	}
}

func TestParseInvalid(t *testing.T) {
	// Mensajes que el server debe ignorar sin panic (SPEC §3).
	cases := []string{
		``,                // vacío
		`not json`,        // no es JSON
		`{`,               // JSON truncado
		`{"dx":1,"dy":2}`, // sin campo "t"
		`{"t":""}`,        // "t" vacío
		`[1,2,3]`,         // JSON válido pero no objeto
		`123`,             // número suelto
		`{"t":123}`,       // "t" del tipo equivocado
	}
	for _, c := range cases {
		t.Run(c, func(t *testing.T) {
			if _, ok := Parse([]byte(c)); ok {
				t.Errorf("Parse(%q) ok=true, esperaba false (debe ignorarse)", c)
			}
		})
	}
}

func TestParseUnknownType(t *testing.T) {
	// Un "t" desconocido parsea ok (forward-compat); el ruteo lo descarta.
	got, ok := Parse([]byte(`{"t":"futuro","dx":5}`))
	if !ok {
		t.Fatal("tipo desconocido debería parsear ok=true")
	}
	if got.Type != "futuro" {
		t.Errorf("Type = %q, want futuro", got.Type)
	}
}

func TestParseRejectsOutOfBoundsAndMalformedFrames(t *testing.T) {
	cases := []string{
		`{"t":"m","dx":10001}`,
		`{"t":"b","a":"hold","btn":"l"}`,
		`{"t":"b","a":"down","btn":"x"}`,
		`{"t":"k","a":"special","key":"RunCommand"}`,
		`{"t":"k","a":"combo","mods":["ctrl","ctrl"],"key":"c"}`,
		`{"t":"t","c":[{"id":1,"x":1.1,"y":0.5}]}`,
		`{"t":"t","c":[{"id":1,"x":0.5,"y":0.5},{"id":1,"x":0.6,"y":0.5}]}`,
		`{"t":"t"}`,
		`{"t":"t","c":null}`,
		`{"t":"t","c":[{"id":1,"x":0.5,"y":0.5}],"cancel":true}`,
		`{"t":"g","name":"not-a-gesture"}`,
	}
	for _, raw := range cases {
		if _, ok := Parse([]byte(raw)); ok {
			t.Errorf("Parse(%s) ok=true, want false", raw)
		}
	}
	if _, ok := Parse([]byte(`{"t":"k","a":"text","text":""}`)); !ok {
		t.Error("texto vacío es un no-op válido")
	}
	if _, ok := Parse(make([]byte, maxFrameBytes+1)); ok {
		t.Error("frame mayor al límite aceptado")
	}
}

func TestParseCanonicalizesComboModifiers(t *testing.T) {
	got, ok := Parse([]byte(`{"t":"k","a":"combo","mods":["CTRL","Shift"],"key":"c"}`))
	if !ok {
		t.Fatal("combo con modificadores en mayúscula debería ser válido")
	}
	if got.Mods[0] != "ctrl" || got.Mods[1] != "shift" {
		t.Fatalf("mods no canonicalizados: %#v", got.Mods)
	}
	if _, ok := Parse([]byte(`{"t":"k","a":"combo","mods":["CTRL","ctrl"],"key":"c"}`)); ok {
		t.Fatal("mods duplicados después de lowercase deben rechazarse")
	}
}
