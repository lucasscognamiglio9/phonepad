package input

// Demo deliberately never opens an input device. It is opt-in and visible in UI.
type Demo struct{}

func (*Demo) Move(int, int)          {}
func (*Demo) Button(string, bool)    {}
func (*Demo) Scroll(int, int)        {}
func (*Demo) Text(string)            {}
func (*Demo) Special(string)         {}
func (*Demo) Combo([]string, string) {}
func (*Demo) Gesture(string)         {}
func (*Demo) Touch([]Contact)        {}
func (*Demo) Reset()                 {}
func (*Demo) Close()                 {}

// Demo exposes the same stable legacy mapper used by the production mobile
// provider so the preview can exercise the negotiated contract. It never
// claims that input is effective; the server still reports Effective=false.
func (*Demo) PointerGeometry() (PointerGeometry, bool) {
	return PointerGeometry{ID: "legacy-100x70", Kind: "legacy-aspect-fit",
		WidthMM: 100, HeightMM: 70, GeometryEpoch: 1}, true
}
