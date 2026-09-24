//go:build darwin && !cgo

package input

func nativeAccessibilityTrusted() bool { return false }
func nativeFocus() (string, error)     { return "", errNativeFocusUnavailable }
