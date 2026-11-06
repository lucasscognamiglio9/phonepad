//go:build linux

package input

import (
	"reflect"
	"testing"

	"github.com/bendahl/uinput"
)

func TestPlanTextTypesLatamSymbolsWithTheirKeys(t *testing.T) {
	_, keys, err := parseLayoutKeys([]byte(`{"layout":"latam","keys":{"64":[3,false,true],"60":[86,false,false],"62":[86,true,false],"191":[13,false,false],"10":[28,false,false]}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := planText("@<>¿é\n", keys)
	want := []textOp{
		{keyChord: keyChord{code: uinput.Key2, altgr: true}},
		{keyChord: keyChord{code: uinput.Key102Nd}},
		{keyChord: keyChord{code: uinput.Key102Nd, shift: true}},
		{keyChord: keyChord{code: uinput.KeyEqual}},
		{paste: "é"},
		{keyChord: keyChord{code: uinput.KeyEnter}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("planText = %+v, want %+v", got, want)
	}
}
