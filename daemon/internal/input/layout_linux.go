//go:build linux

package input

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

//go:embed xkb_layout.py
var xkbLayoutScript string

// keyChord is how the active keyboard layout produces one character: an evdev
// key plus the Shift and AltGr levels the compositor applies to it.
type keyChord struct {
	code  int
	shift bool
	altgr bool
}

type layoutKeys map[rune]keyChord

// usLayoutKeys is the fallback when the GNOME layout cannot be read.
func usLayoutKeys() layoutKeys {
	keys := make(layoutKeys, len(asciiNoShift)+len(asciiShift))
	for r, code := range asciiNoShift {
		keys[r] = keyChord{code: code}
	}
	for r, code := range asciiShift {
		keys[r] = keyChord{code: code, shift: true}
	}
	return keys
}

// parseLayoutKeys reads the xkb_layout.py output. Control characters keep the
// US entries because the keymap reports Return as "\r", not "\n".
func parseLayoutKeys(raw []byte) (string, layoutKeys, error) {
	var payload struct {
		Layout string            `json:"layout"`
		Keys   map[string][3]any `json:"keys"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", nil, err
	}
	keys := layoutKeys{'\n': {code: asciiNoShift['\n']}, '\t': {code: asciiNoShift['\t']}}
	for char, entry := range payload.Keys {
		r, err := strconv.Atoi(char)
		code, codeOK := entry[0].(float64)
		shift, shiftOK := entry[1].(bool)
		altgr, altgrOK := entry[2].(bool)
		if err != nil || !codeOK || !shiftOK || !altgrOK || code <= 0 || code > 247 {
			continue
		}
		keys[rune(r)] = keyChord{code: int(code), shift: shift, altgr: altgr}
	}
	return payload.Layout, keys, nil
}

// layoutCache keeps the active layout's table. The first lookup waits for
// it; later lookups refresh it in the background so a layout switch in GNOME
// reaches typing within a few seconds without a process per keystroke.
type layoutCache struct {
	mu         sync.Mutex
	keys       layoutKeys
	name       string
	loadedAt   time.Time
	refreshing bool
}

const layoutRefreshInterval = 3 * time.Second

func (c *layoutCache) current() layoutKeys {
	c.mu.Lock()
	if c.keys == nil {
		c.mu.Unlock()
		c.refresh()
		c.mu.Lock()
	} else if !c.refreshing && time.Since(c.loadedAt) > layoutRefreshInterval {
		c.refreshing = true
		go c.refresh()
	}
	defer c.mu.Unlock()
	return c.keys
}

func (c *layoutCache) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	name, keys, err := loadLayoutKeys(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshing = false
	c.loadedAt = time.Now()
	if err != nil {
		if c.keys == nil {
			log.Printf("keyboard layout unavailable, typing with US keys: %v", err)
			c.keys = usLayoutKeys()
		}
		return
	}
	if name != c.name {
		log.Printf("keyboard layout: %s", name)
	}
	c.name, c.keys = name, keys
}

func loadLayoutKeys(ctx context.Context) (string, layoutKeys, error) {
	out, err := exec.CommandContext(ctx, "/usr/bin/python3", "-c", xkbLayoutScript).Output()
	if err != nil {
		return "", nil, err
	}
	return parseLayoutKeys(out)
}
