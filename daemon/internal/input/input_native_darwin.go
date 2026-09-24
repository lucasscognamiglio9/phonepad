package input

import (
	"errors"

	robot "github.com/go-vgo/robotgo/darwin"
)

func nativeReady() error {
	width, height := robot.GetScreenSize()
	if width <= 0 || height <= 0 || !nativeAccessibilityTrusted() {
		return ErrProviderUnavailable
	}
	robot.KeySleep = 0
	return nil
}
func nativeScreenSize() (int, int)  { return robot.GetScreenSize() }
func nativeMoveRelative(dx, dy int) { robot.MoveRelative(dx, dy) }
func nativeMoveTo(x, y int)         { robot.Move(x, y) }
func nativeButton(button string, down bool) error {
	name := map[string]string{"l": "left", "r": "right", "m": "middle"}[button]
	if down {
		return robot.MouseDown(name)
	}
	return robot.MouseUp(name)
}
func nativeScroll(dx, dy int) { robot.Scroll(dx, dy, 0) }
func nativeType(value string) { robot.TypeStr(value) }
func nativeKeyTap(key string, mods []string) error {
	args := make([]interface{}, len(mods))
	for i, mod := range mods {
		args[i] = mod
	}
	return robot.KeyTap(key, args...)
}
func nativeModifier(mod string) string {
	switch mod {
	case "Ctrl", "Control":
		return "ctrl"
	case "Alt":
		return "alt"
	case "Shift":
		return "shift"
	case "Super", "Meta":
		return "cmd"
	}
	return ""
}
func nativeGesture(name string) (string, []string, bool) {
	switch name {
	case "overview":
		return "up", []string{"Ctrl"}, true
	case "ws-left":
		return "left", []string{"Ctrl"}, true
	case "ws-right":
		return "right", []string{"Ctrl"}, true
	}
	return "", nil, false
}

var errNativeFocusUnavailable = errors.New("focused editable element unavailable")
