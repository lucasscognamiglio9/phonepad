//go:build darwin || windows

package input

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"math"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// nativeDevice sends input through the host's accessibility/input APIs. The
// phone supplies normalized contacts; this adapter maps their deltas against
// the current display size, so orientation and screen resolution are not
// baked into the protocol.
type nativeDevice struct {
	mu                  sync.Mutex
	contacts            map[int]Contact
	started             time.Time
	start               Contact
	moved               bool
	multi               bool
	scrollX, scrollY    float64
	buttons             map[string]bool
	absWidth, absHeight int
	closed              bool
}

func New() (Injector, error) {
	if err := nativeReady(); err != nil {
		return nil, err
	}
	return &nativeDevice{contacts: make(map[int]Contact), buttons: make(map[string]bool)}, nil
}

func NewAbsolute(width, height int) (AbsInjector, error) {
	if width <= 0 || height <= 0 {
		return nil, ErrProviderUnavailable
	}
	injector, err := New()
	if err != nil {
		return nil, err
	}
	device := injector.(*nativeDevice)
	device.absWidth, device.absHeight = width, height
	return device, nil
}

func (d *nativeDevice) Move(dx, dy int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.closed {
		nativeMoveRelative(dx, dy)
	}
}

func (d *nativeDevice) MoveTo(x, y int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.absWidth == 0 || d.absHeight == 0 {
		return
	}
	w, h := nativeScreenSize()
	if w > 0 && h > 0 {
		nativeMoveTo(x*w/d.absWidth, y*h/d.absHeight)
	}
}

func (d *nativeDevice) SupportsDirectPointer() bool { return true }
func (d *nativeDevice) MoveNormalized(x, y int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	w, h := nativeScreenSize()
	if w > 0 && h > 0 {
		nativeMoveTo(x*w/65535, y*h/65535)
	}
}

func (d *nativeDevice) Button(button string, down bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || (button != "l" && button != "r" && button != "m") {
		return
	}
	if err := nativeButton(button, down); err != nil {
		log.Printf("native mouse button: %v", err)
		return
	}
	d.buttons[button] = down
}

func (d *nativeDevice) Scroll(dx, dy int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.closed {
		nativeScroll(dx, dy)
	}
}

func (d *nativeDevice) Text(value string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.closed && utf8.ValidString(value) {
		nativeType(value)
	}
}

func nativeKeyName(key string) string {
	switch strings.ToLower(key) {
	case "enter", "return":
		return "enter"
	case "escape", "esc":
		return "esc"
	case "backspace":
		return "backspace"
	case "delete":
		return "delete"
	case "tab":
		return "tab"
	case "space":
		return "space"
	case "arrowup", "up":
		return "up"
	case "arrowdown", "down":
		return "down"
	case "arrowleft", "left":
		return "left"
	case "arrowright", "right":
		return "right"
	case "home":
		return "home"
	case "end":
		return "end"
	case "pageup":
		return "pageup"
	case "pagedown":
		return "pagedown"
	}
	if utf8.RuneCountInString(key) == 1 && isUSKeyRune([]rune(key)[0]) {
		return key
	}
	return ""
}

func (d *nativeDevice) Special(key string) { _ = d.SpecialAction(context.Background(), key) }
func (d *nativeDevice) SpecialAction(ctx context.Context, key string) ActionResult {
	if ctx.Err() != nil {
		return ActionResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	name := nativeKeyName(key)
	if name == "" {
		return ActionResult{State: "rejected", Detail: "unknown_special"}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return ActionResult{State: "rejected", Detail: "injector_closed"}
	}
	if err := nativeKeyTap(name, nil); err != nil {
		return ActionResult{State: "uncertain", Detail: "native_key_interrupted"}
	}
	return ActionResult{State: "executed"}
}

func (d *nativeDevice) Combo(mods []string, key string) {
	_ = d.ComboAction(context.Background(), mods, key)
}
func (d *nativeDevice) ComboAction(ctx context.Context, mods []string, key string) ActionResult {
	if ctx.Err() != nil {
		return ActionResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	name := nativeKeyName(key)
	if name == "" {
		return ActionResult{State: "rejected", Detail: "unknown_combo_key"}
	}
	converted := make([]string, len(mods))
	for i, mod := range mods {
		converted[i] = nativeModifier(mod)
		if converted[i] == "" {
			return ActionResult{State: "rejected", Detail: "unknown_modifier"}
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return ActionResult{State: "rejected", Detail: "injector_closed"}
	}
	if err := nativeKeyTap(name, converted); err != nil {
		return ActionResult{State: "uncertain", Detail: "native_combo_interrupted"}
	}
	return ActionResult{State: "executed"}
}

func (d *nativeDevice) Gesture(name string) {
	key, mods, ok := nativeGesture(name)
	if ok {
		_ = d.ComboAction(context.Background(), mods, key)
	}
}

func (d *nativeDevice) Touch(contacts []Contact) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	next := make(map[int]Contact, len(contacts))
	for _, contact := range contacts {
		next[contact.ID] = contact
	}
	if len(d.contacts) == 0 && len(next) > 0 {
		d.started = time.Now()
		d.moved = false
		d.multi = len(next) > 1
		for _, contact := range next {
			d.start = contact
			break
		}
	}
	if len(next) > 1 {
		d.multi = true
	}
	if len(next) == 0 && len(d.contacts) > 0 {
		if !d.moved && time.Since(d.started) < 300*time.Millisecond {
			button := "l"
			if d.multi {
				button = "r"
			}
			if err := nativeButton(button, true); err == nil {
				_ = nativeButton(button, false)
			}
		}
		d.contacts = next
		d.scrollX, d.scrollY = 0, 0
		return
	}
	if len(next) == 1 && len(d.contacts) == 1 && !d.multi {
		for id, contact := range next {
			if old, ok := d.contacts[id]; ok {
				width, height := nativeScreenSize()
				if width > 0 && height > 0 {
					dx := int(math.Round((contact.X - old.X) * float64(width)))
					dy := int(math.Round((contact.Y - old.Y) * float64(height)))
					if dx != 0 || dy != 0 {
						nativeMoveRelative(dx, dy)
					}
				}
				if math.Hypot(contact.X-d.start.X, contact.Y-d.start.Y) > .015 {
					d.moved = true
				}
			}
		}
	} else if len(next) >= 2 && len(d.contacts) >= 2 {
		var dx, dy float64
		count := 0
		for id, contact := range next {
			if old, ok := d.contacts[id]; ok {
				dx += contact.X - old.X
				dy += contact.Y - old.Y
				count++
			}
		}
		if count > 0 {
			d.scrollX += dx / float64(count) * 20
			d.scrollY += dy / float64(count) * 20
			sx, sy := int(d.scrollX), int(d.scrollY)
			d.scrollX -= float64(sx)
			d.scrollY -= float64(sy)
			if sx != 0 || sy != 0 {
				nativeScroll(sx, -sy)
				d.moved = true
			}
		}
	}
	d.contacts = next
}

func (d *nativeDevice) CancelTouch() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.contacts = make(map[int]Contact)
	d.moved = false
	d.multi = false
	d.scrollX, d.scrollY = 0, 0
}
func (d *nativeDevice) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.contacts = make(map[int]Contact)
	d.moved = false
	d.multi = false
	d.scrollX, d.scrollY = 0, 0
	for button, down := range d.buttons {
		if down {
			_ = nativeButton(button, false)
		}
		delete(d.buttons, button)
	}
}
func (d *nativeDevice) Close() { d.Reset(); d.mu.Lock(); d.closed = true; d.mu.Unlock() }

func (d *nativeDevice) LiteralFocus(ctx context.Context) LiteralResult {
	if ctx.Err() != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	focus, err := nativeFocus()
	if err != nil || focus == "" {
		return LiteralResult{State: "rejected", Detail: "editable_focus_unavailable"}
	}
	hash := sha256.Sum256([]byte(focus))
	return LiteralResult{State: "ready", Target: hex.EncodeToString(hash[:])}
}
func (d *nativeDevice) LiteralText(ctx context.Context, value, target string) LiteralResult {
	if !utf8.ValidString(value) || value == "" || len(value) > 128*1024 || len(target) != 64 {
		return LiteralResult{State: "rejected", Detail: "invalid_literal"}
	}
	if ctx.Err() != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	focus, err := nativeFocus()
	if err != nil || focus == "" {
		return LiteralResult{State: "rejected", Detail: "editable_focus_unavailable"}
	}
	hash := sha256.Sum256([]byte(focus))
	if hex.EncodeToString(hash[:]) != target {
		return LiteralResult{State: "rejected", Detail: "editable_focus_changed"}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return LiteralResult{State: "rejected", Detail: "injector_closed"}
	}
	nativeType(value)
	return LiteralResult{State: "dispatched", Detail: "native_unicode_input"}
}
