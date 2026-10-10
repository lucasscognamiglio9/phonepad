//go:build darwin && cgo

package input

/*
#cgo LDFLAGS: -framework ApplicationServices
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>

static int pp_accessibility_trusted(void) {
    CFMutableDictionaryRef options = CFDictionaryCreateMutable(kCFAllocatorDefault, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!options) return AXIsProcessTrusted();
    CFDictionarySetValue(options, kAXTrustedCheckOptionPrompt, kCFBooleanTrue);
    Boolean trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    return trusted;
}

static char* pp_focused_editable(void) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementRef focus = NULL;
    if (!system) return NULL;
    AXError error = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute, (CFTypeRef*)&focus);
    CFRelease(system);
    if (error != kAXErrorSuccess || !focus) return NULL;
    CFTypeRef role = NULL;
    error = AXUIElementCopyAttributeValue(focus, kAXRoleAttribute, &role);
    int editable = error == kAXErrorSuccess && role && CFGetTypeID(role) == CFStringGetTypeID() &&
        (CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole) || CFEqual(role, kAXComboBoxRole));
    if (role) CFRelease(role);
    Boolean settable = false;
    if (editable) error = AXUIElementIsAttributeSettable(focus, kAXValueAttribute, &settable);
    if (!editable || error != kAXErrorSuccess || !settable) { CFRelease(focus); return NULL; }
    pid_t pid = 0;
    AXUIElementGetPid(focus, &pid);
    CFHashCode identity = CFHash(focus);
    char* result = malloc(80);
    if (result) snprintf(result, 80, "mac:%d:%llu", pid, (unsigned long long)identity);
    CFRelease(focus);
    return result;
}
*/
import "C"
import "unsafe"

func nativeAccessibilityTrusted() bool { return C.pp_accessibility_trusted() != 0 }
func nativeFocus() (string, error) {
	value := C.pp_focused_editable()
	if value == nil {
		return "", errNativeFocusUnavailable
	}
	defer C.free(unsafe.Pointer(value))
	return C.GoString(value), nil
}
