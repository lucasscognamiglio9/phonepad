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
