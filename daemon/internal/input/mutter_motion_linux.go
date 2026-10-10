//go:build linux

package input

import (
	"context"
	"encoding/xml"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

const mutterRemoteDesktop = "org.gnome.Mutter.RemoteDesktop"

// Mutter's relative motion API accepts already-scaled deltas. It bypasses
// libinput's velocity acceleration without changing the user's other devices.
// A private connection confines the native pointer lease to this injector.
type mutterMotion struct {
	conn    *dbus.Conn
	session dbus.BusObject
	failed  bool
}

func newMutterMotion() (*mutterMotion, error) {
	if os.Getenv("WAYLAND_DISPLAY") == "" || !strings.Contains(strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP")), "GNOME") {
		return nil, ErrProviderUnavailable
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	p := &mutterMotion{conn: conn}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var path dbus.ObjectPath
	err = conn.Object(mutterRemoteDesktop, "/org/gnome/Mutter/RemoteDesktop").CallWithContext(ctx, mutterRemoteDesktop+".CreateSession", 0).Store(&path)
	if err == nil {
		p.session = conn.Object(mutterRemoteDesktop, path)
		err = p.validateContract(ctx)
		if err == nil {
			err = p.session.CallWithContext(ctx, mutterRemoteDesktop+".Session.Start", 0).Err
		}
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// Mutter exposes a private, version-dependent interface. Admit the provider
// only when its wire signatures match, before it receives any user input.
func (p *mutterMotion) validateContract(ctx context.Context) error {
	var description string
	if err := p.session.CallWithContext(ctx, "org.freedesktop.DBus.Introspectable.Introspect", 0).Store(&description); err != nil {
		return err
	}
	var node struct {
		Interfaces []struct {
			Name    string `xml:"name,attr"`
			Methods []struct {
				Name string `xml:"name,attr"`
				Args []struct {
					Type      string `xml:"type,attr"`
					Direction string `xml:"direction,attr"`
				} `xml:"arg"`
			} `xml:"method"`
		} `xml:"interface"`
	}
	if err := xml.Unmarshal([]byte(description), &node); err != nil {
		return err
	}
	required := map[string]string{"Start": "", "Stop": "", "NotifyPointerMotionRelative": "dd", "NotifyPointerButton": "ib"}
	for _, iface := range node.Interfaces {
		if iface.Name != mutterRemoteDesktop+".Session" {
			continue
		}
		for _, method := range iface.Methods {
			expected, ok := required[method.Name]
			if !ok {
				continue
			}
			signature := ""
			for _, arg := range method.Args {
				if arg.Direction != "out" {
					signature += arg.Type
				}
			}
			if signature != expected {
				return fmt.Errorf("incompatible Mutter %s signature %q", method.Name, signature)
			}
			delete(required, method.Name)
		}
	}
	if len(required) != 0 {
		return fmt.Errorf("Mutter pointer contract is incomplete")
	}
	return nil
}
func (p *mutterMotion) call(method string, args ...interface{}) error {
	if p.failed || p.session == nil {
		return ErrProviderUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	err := p.session.CallWithContext(ctx, mutterRemoteDesktop+".Session."+method, 0, args...).Err
	if err != nil {
		p.failed = true
		log.Printf("PhonePad linear pointer stopped: %v", err)
	}
	return err
}
func (p *mutterMotion) Move(dx, dy float64) error {
	return p.call("NotifyPointerMotionRelative", dx, dy)
}
func (p *mutterMotion) Button(down bool) error {
	// Even after a failed motion, attempt to release a possibly held button.
	if !down && p.session != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		defer cancel()
		return p.session.CallWithContext(ctx, mutterRemoteDesktop+".Session.NotifyPointerButton", 0, int32(0x110), false).Err
	}
	return p.call("NotifyPointerButton", int32(0x110), down)
}
func (p *mutterMotion) Close() {
	if p.session != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		_ = p.session.CallWithContext(ctx, mutterRemoteDesktop+".Session.Stop", 0).Err
		cancel()
		p.session = nil
	}
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
}
