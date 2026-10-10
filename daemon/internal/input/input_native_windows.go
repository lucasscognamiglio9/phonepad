package input

import (
	"errors"
	"fmt"
	"unsafe"

	robot "github.com/go-vgo/robotgo/win"
	"golang.org/x/sys/windows"
)

var getGUIThreadInfo = windows.NewLazySystemDLL("user32.dll").NewProc("GetGUIThreadInfo")

type nativeRect struct{ Left, Top, Right, Bottom int32 }
type guiThreadInfo struct {
	Size                                               uint32
	Flags                                              uint32
	Active, Focus, Capture, MenuOwner, MoveSize, Caret uintptr
	CaretRect                                          nativeRect
}

func nativeReady() error {
	width, height := robot.GetScreenSize()
	if width <= 0 || height <= 0 {
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
		return "win"
	}
	return ""
}
func nativeGesture(name string) (string, []string, bool) {
	switch name {
	case "overview":
		return "tab", []string{"Super"}, true
	case "ws-left":
		return "left", []string{"Ctrl", "Super"}, true
	case "ws-right":
		return "right", []string{"Ctrl", "Super"}, true
	}
	return "", nil, false
}
func nativeFocus() (string, error) {
	info := guiThreadInfo{Size: uint32(unsafe.Sizeof(guiThreadInfo{}))}
	ok, _, err := getGUIThreadInfo.Call(0, uintptr(unsafe.Pointer(&info)))
	if ok == 0 || info.Focus == 0 {
		if err != windows.ERROR_SUCCESS {
			return "", err
		}
		return "", errors.New("focused control unavailable")
	}
	return fmt.Sprintf("win:%x", info.Focus), nil
}
