package server

import "testing"

func TestParseActionReceiptCommandsAndSequenceRules(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"press", `{"t":"k","a":"special","key":"Enter","operationId":"op-1","phase":"press","actionSequence":1}`, true},
		{"implicit press", `{"t":"k","a":"special","key":"Enter","operationId":"op-2"}`, true},
		{"repeat", `{"t":"k","a":"combo","mods":["ctrl"],"key":"c","operationId":"op-1","phase":"repeat","actionSequence":2}`, true},
		{"cancel", `{"t":"k","a":"cancel","operationId":"op-1","phase":"cancel"}`, true},
		{"repeat missing sequence", `{"t":"k","a":"special","key":"Enter","operationId":"op-1","phase":"repeat"}`, false},
		{"text operation", `{"t":"k","a":"text","text":"hola","operationId":"op-1"}`, false},
		{"cancel payload", `{"t":"k","a":"cancel","operationId":"op-1","key":"Enter"}`, false},
		{"invalid operation id", `{"t":"k","a":"special","key":"Enter","operationId":"op/1"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := Parse([]byte(tc.raw)); ok != tc.want {
				t.Fatalf("Parse(%s) = %v, want %v", tc.raw, ok, tc.want)
			}
		})
	}
}
