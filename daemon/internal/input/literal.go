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
)

//go:embed literal_text.py
var literalTextScript string

const (
	literalMaxBytes              = 128 * 1024
	clipboardFallbackTarget      = ClipboardFallbackTarget
	clipboardFallbackShortcutEnv = "PHONEPAD_CLIPBOARD_FALLBACK_SHORTCUT"
)

func (d *uinputDevice) LiteralFocus(ctx context.Context) LiteralResult {
	// The accessibility probe does not use virtual input device state. Holding
	// the pointer lock during this external call would stall mouse gestures.
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
