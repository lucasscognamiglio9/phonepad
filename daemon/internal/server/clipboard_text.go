package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"phonepad/daemon/internal/input"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const maxClipboardText = 128 << 10

func readDesktopClipboardText(ctx context.Context) (string, error) {
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.CommandContext(ctx, "pbpaste")
	} else if runtime.GOOS == "windows" {
		command = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw")
	} else if os.Getenv("WAYLAND_DISPLAY") != "" {
		command = exec.CommandContext(ctx, "wl-paste", "--no-newline", "--type", "text/plain")
	} else if os.Getenv("DISPLAY") != "" {
		command = exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING")
	} else {
		return "", errors.New("no clipboard provider")
	}
	pipe, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err = command.Start(); err != nil {
		return "", err
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, maxClipboardText+1))
	if readErr != nil || len(data) > maxClipboardText {
		_ = command.Process.Kill()
	}
	err = command.Wait()
	if readErr != nil || err != nil || len(data) > maxClipboardText || !utf8.Valid(data) {
		return "", errors.New("clipboard text unavailable or too large")
	}
	return string(data), nil
}

// Only an explicit foreground action calls this endpoint. No clipboard polling.
func (s *Server) handleClipboardText(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.rejectIfClosing(w) {
		return
	}
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "origin", 403)
		return
	}
	if r.Method != "GET" && r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	permit, allowed := s.captureMutationPermit(mutationScopeClipboard)
	if !allowed {
		http.Error(w, "clipboard permission revoked", 403)
		return
	}
	if permit.sessionEpoch == "" || r.Header.Get("X-PhonePad-Session") != permit.sessionEpoch {
		http.Error(w, "stale session", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var text string
	if r.Method == "POST" {
		var request struct {
			Text string `json:"text"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 6*maxClipboardText+64))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil {
			http.Error(w, "invalid text", 400)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF || !utf8.ValidString(request.Text) || strings.ContainsRune(request.Text, 0) || len(request.Text) > maxClipboardText {
			http.Error(w, "invalid text", 400)
			return
		}
		text = request.Text
	}
	err := s.runPermittedMutation(permit, func() error {
		input.ClipboardMu.Lock()
		defer input.ClipboardMu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if r.Method == "GET" {
			read := s.readClipboardText
			if read == nil {
				read = readDesktopClipboardText
			}
			var err error
			text, err = read(ctx)
			return err
		}
		file, err := os.CreateTemp("", "phonepad-clipboard-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err = file.WriteString(text); err != nil {
			file.Close()
			return err
		}
		if err = file.Close(); err != nil {
			return err
		}
		s.clipboardMu.Lock()
		defer s.clipboardMu.Unlock()
		if s.clipboard == nil {
			s.clipboard = systemClipboard()
		}
		return s.clipboard.Copy(file.Name(), clipboardText, "text/plain;charset=utf-8")
	})
	if err != nil {
		http.Error(w, "clipboard unavailable; do not retry automatically", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "GET" {
		_ = json.NewEncoder(w).Encode(map[string]any{"text": text, "sessionEpoch": permit.sessionEpoch})
	} else {
		_ = json.NewEncoder(w).Encode(map[string]any{"state": "ready", "sessionEpoch": permit.sessionEpoch})
	}
}
