//go:build linux

package input

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bendahl/uinput"
)

//go:embed literal_text.py
var literalTextScript string

const (
	literalMaxBytes              = 128 * 1024
	clipboardFallbackTarget      = "dfb7c03e49a8ecb781d00ea95ff5c9924657c8dd1a3d05ebdc0cc090ef1b9ec8"
	clipboardFallbackShortcutEnv = "PHONEPAD_CLIPBOARD_FALLBACK_SHORTCUT"
)

func (d *uinputDevice) LiteralFocus(ctx context.Context) LiteralResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	result := runLiteral(ctx, map[string]string{"op": "probe"})
	if result.State == "rejected" && (result.Detail == "editable_focus_unavailable" || result.Detail == "literal_adapter_unavailable") {
		if clipboardFallbackAvailable() && clipboardFallbackShortcutAvailable() {
			return LiteralResult{State: "ready", Detail: "clipboard_fallback", Target: clipboardFallbackTarget}
		}
		return LiteralResult{State: "rejected", Detail: "literal_and_clipboard_shortcut_unavailable"}
	}
	return result
}
func (d *uinputDevice) LiteralText(ctx context.Context, text, target string) LiteralResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !utf8.ValidString(text) || len(text) == 0 || len(text) > literalMaxBytes || bytes.IndexByte([]byte(text), 0) >= 0 || len(target) != 64 {
		return LiteralResult{State: "rejected", Detail: "invalid_literal"}
	}
	if target == clipboardFallbackTarget {
		if !clipboardFallbackShortcutAvailable() {
			return LiteralResult{State: "rejected", Detail: "clipboard_paste_shortcut_unavailable"}
		}
		return d.clipboardLiteralText(ctx, text)
	}
	return runLiteral(ctx, map[string]string{"op": "insert", "text": text, "target": target})
}

// The fallback has no portable way to infer a target's paste convention once
// AT-SPI reports no EditableText. Require an explicit deployment capability;
// Ctrl+V is intentionally never assumed for terminals or other consumers.
func clipboardFallbackShortcutAvailable() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(clipboardFallbackShortcutEnv)), "ctrl-v")
}

func clipboardFallbackAvailable() bool {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		_, copyErr := exec.LookPath("wl-copy")
		_, pasteErr := exec.LookPath("wl-paste")
		return copyErr == nil && pasteErr == nil
	}
	if os.Getenv("DISPLAY") != "" {
		_, err := exec.LookPath("xclip")
		return err == nil
	}
	return false
}

func clipboardLiteralCopyCommand() *exec.Cmd {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return exec.Command("wl-copy")
	}
	return exec.Command("xclip", "-selection", "clipboard", "-t", "text/plain;charset=utf-8", "-i")
}

func clipboardLiteralRestoreCommand(mime string) *exec.Cmd {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return exec.Command("wl-copy", "--type", mime)
	}
	return exec.Command("xclip", "-selection", "clipboard", "-t", mime, "-i")
}

type clipboardLiteralOffer struct {
	command *exec.Cmd
	done    <-chan error
}

// startClipboardLiteralOffer keeps the provider alive for a bounded consumer
// window. Provider exit is not treated as a paste receipt: a compositor or
// consumer may ask for TARGETS before it asks for the payload.
func startClipboardLiteralOffer(text string) (*clipboardLiteralOffer, error) {
	var command *exec.Cmd
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		command = exec.Command("wl-copy", "--foreground")
	} else if os.Getenv("DISPLAY") != "" {
		command = exec.Command("xclip", "-selection", "clipboard", "-i", "-quiet")
	} else {
		return nil, os.ErrNotExist
	}
	command.Stdin = bytes.NewReader([]byte(text))
	if err := command.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	return &clipboardLiteralOffer{command: command, done: done}, nil
}

func stopClipboardLiteralOffer(offer *clipboardLiteralOffer) {
	if offer == nil {
		return
	}
	select {
	case <-offer.done:
		return
	default:
	}
	if offer.command.Process != nil {
		_ = offer.command.Process.Kill()
	}
	// The waiter goroutine reaps the child. Do not block the input worker on a
	// compositor/provider that stopped servicing the Wayland connection.
}

// waitClipboardLiteralOffer waits for a bounded offer window. It never treats
// provider exit or a TARGETS request as consumption, and it never claims that
// the target inserted the bytes into its edit buffer.
func waitClipboardLiteralOffer(ctx context.Context, offer *clipboardLiteralOffer) (bool, string) {
	if offer == nil {
		return false, "clipboard_offer_unavailable"
	}
	timer := time.NewTimer(clipboardCommandTimeout)
	defer timer.Stop()
	select {
	case err := <-offer.done:
		if err != nil {
			return false, "clipboard_offer_interrupted"
		}
		return false, "clipboard_offer_ended_before_consumption"
	case <-ctx.Done():
		return false, "clipboard_consumption_unobserved"
	case <-timer.C:
		return false, "clipboard_consumption_unobserved"
	}
}

// clipboardLiteralText is deliberately conservative. It can offer the full
// Unicode block and issue one paste to a focused app without EditableText, but
// it cannot observe that app's edit buffer. It returns uncertain even when the
// provider and key calls complete, so the client never retries blindly.
func (d *uinputDevice) clipboardLiteralText(ctx context.Context, text string) LiteralResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	ClipboardMu.Lock()
	defer ClipboardMu.Unlock()
	offer, err := startClipboardLiteralOffer(text)
	if err != nil {
		return LiteralResult{State: "rejected", Detail: "clipboard_unavailable"}
	}
	uncertain := func(detail string) LiteralResult {
		stopClipboardLiteralOffer(offer)
		return LiteralResult{State: "uncertain", Detail: detail}
	}
	if err := ctx.Err(); err != nil {
		return uncertain("clipboard_owned")
	}
	if down := d.keyDownResult(uinput.KeyLeftctrl); down.State != "executed" {
		return uncertain("clipboard_owned")
	}
	press := d.keyPressResult(uinput.KeyV)
	up := d.keyUpResult(uinput.KeyLeftctrl)
	if press.State != "executed" || up.State != "executed" {
		return uncertain("clipboard_owned")
	}
	_, detail := waitClipboardLiteralOffer(ctx, offer)
	// Neither Wayland nor X11 exposes the target's edit-buffer mutation here.
	// Keep the offered content and surface uncertainty instead of restoring by
	// byte equality; a second process may have become owner with the same text.
	return uncertain(detail)
}
func runLiteral(ctx context.Context, request map[string]string) LiteralResult {
	if ctx.Err() != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	payload, _ := json.Marshal(request)
	bounded, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, "/usr/bin/python3", "-c", literalTextScript)
	command.Stdin = bytes.NewReader(payload)
	// Only a fixed-size status is emitted by the helper; stderr is not logged.
	var output bytes.Buffer
	command.Stdout = &output
	if err := command.Start(); err != nil {
		return LiteralResult{State: "rejected", Detail: "literal_adapter_unavailable"}
	}
	if err := command.Wait(); err != nil {
		return LiteralResult{State: "uncertain", Detail: "literal_adapter_interrupted"}
	}
	var result LiteralResult
	if output.Len() > 4096 || json.Unmarshal(output.Bytes(), &result) != nil {
		return LiteralResult{State: "uncertain", Detail: "invalid_adapter_receipt"}
	}
	if result.State != "ready" && result.State != "rejected" && result.State != "dispatched" && result.State != "uncertain" {
		return LiteralResult{State: "uncertain", Detail: "invalid_adapter_receipt"}
	}
	return result
}
