package server

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
)

// nativeHostClipboard uses the operating system clipboard. The path is passed
// as an argument or environment variable, never interpolated into a script.
type nativeHostClipboard struct{}

func (nativeHostClipboard) Copy(path string, kind clipboardKind, _ string) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardCommandTimeout)
	defer cancel()
	if runtime.GOOS == "darwin" {
		if kind == clipboardText {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()
			cmd := exec.CommandContext(ctx, "pbcopy")
			cmd.Stdin = file
			return cmd.Run()
		}
		prepared := path
		cleanup := func() {}
		if kind == clipboardImage {
			var err error
			prepared, cleanup, err = clipboardPNG(path)
			if err != nil {
				prepared, cleanup, err = macOSPNG(ctx, path)
				if err != nil {
					return err
				}
			}
		}
		defer cleanup()
		var script string
		switch kind {
		case clipboardImage:
			script = `on run argv
set f to POSIX file (item 1 of argv)
set the clipboard to (read f as «class PNGf»)
end run`
		case clipboardFile:
			script = `on run argv
set the clipboard to POSIX file (item 1 of argv)
end run`
		default:
			return os.ErrInvalid
		}
		return exec.CommandContext(ctx, "osascript", "-e", script, prepared).Run()
	}
	if runtime.GOOS == "windows" {
		prepared := path
		cleanup := func() {}
		if kind == clipboardImage {
			var err error
			prepared, cleanup, err = clipboardPNG(path)
			if err != nil {
				return err
			}
		}
		defer cleanup()
		var script string
		switch kind {
		case clipboardText:
			script = `[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([IO.File]::ReadAllText($env:PHONEPAD_CLIPBOARD_PATH, [Text.Encoding]::UTF8))`
		case clipboardImage:
			script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [Drawing.Image]::FromFile($env:PHONEPAD_CLIPBOARD_PATH); try { [Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }`
		case clipboardFile:
			script = `Add-Type -AssemblyName System.Windows.Forms; $paths = New-Object System.Collections.Specialized.StringCollection; [void]$paths.Add($env:PHONEPAD_CLIPBOARD_PATH); [Windows.Forms.Clipboard]::SetFileDropList($paths)`
		default:
			return os.ErrInvalid
		}
		cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
		cmd.Env = append(os.Environ(), "PHONEPAD_CLIPBOARD_PATH="+prepared)
		return cmd.Run()
	}
	return errors.New("native clipboard unavailable")
}

func macOSPNG(ctx context.Context, path string) (string, func(), error) {
	if runtime.GOOS != "darwin" {
		return "", func() {}, os.ErrInvalid
	}
	file, cleanup, err := newClipboardTemp(os.TempDir())
	if err != nil {
		return "", func() {}, err
	}
	if err = file.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	cmd := exec.CommandContext(ctx, "sips", "-s", "format", "png", path, "--out", file.Name())
	if err = cmd.Run(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return file.Name(), cleanup, nil
}
