package server

import (
	"time"

	"github.com/godbus/dbus/v5"
)

// DesktopNotice sends a freedesktop notification. It is best effort: without a
// session bus or a notification daemon the transfer still succeeds.
func DesktopNotice(title, body string) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return
	}
	defer conn.Close()
	call := conn.Object("org.freedesktop.Notifications", "/org/freedesktop/Notifications").
		Go("org.freedesktop.Notifications.Notify", 0, nil,
			"Phonepad", uint32(0), "folder-download", title, body, []string{}, map[string]dbus.Variant{}, int32(-1))
	select {
	case <-call.Done:
	case <-time.After(2 * time.Second):
	}
}
