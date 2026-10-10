package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestNativeFileListPreservesOrderedUnicodePathsAsData(t *testing.T) {
	paths := []string{"/Users/amigo/Foto ñ 'uno'.png", "/Users/amigo/$(no-ejecutar); dos.pdf"}
	mac, err := nativeFileListCommand(context.Background(), "darwin", paths)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(mac.Args[3:], paths) {
		t.Fatalf("Mac file arguments changed: %v", mac.Args)
	}
	for _, path := range paths {
		if strings.Contains(mac.Args[2], path) {
			t.Fatal("File name interpolated into AppleScript")
		}
	}
	windowsPaths := []string{`C:\Users\amigo\Foto ñ 'uno'.png`, `C:\Users\amigo\$($false); dos.pdf`}
	windows, err := nativeFileListCommand(context.Background(), "windows", windowsPaths)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(windows.Args, " "), "-STA") {
		t.Fatal("Clipboard requires an STA thread")
	}
	var decoded []string
	for _, value := range windows.Env {
		if strings.HasPrefix(value, "PHONEPAD_CLIPBOARD_PATHS=") {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(value, "PHONEPAD_CLIPBOARD_PATHS=")), &decoded); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !reflect.DeepEqual(decoded, windowsPaths) {
		t.Fatalf("Windows file list changed: %v", decoded)
	}
	for _, path := range windowsPaths {
		if strings.Contains(strings.Join(windows.Args, " "), path) {
			t.Fatal("File name interpolated into PowerShell")
		}
	}
}

func TestNativeFileListRejectsEmptyOversizedAndInvalidPaths(t *testing.T) {
	for _, paths := range [][]string{nil, {""}, {"invalid\x00path"}, make([]string, maxBatchFiles+1)} {
		for _, platform := range []string{"darwin", "windows"} {
			if _, err := nativeFileListCommand(context.Background(), platform, paths); err == nil {
				t.Fatalf("Accepted invalid list on %s", platform)
			}
		}
	}
	if _, err := nativeFileListCommand(context.Background(), "unknown", []string{"file"}); err == nil {
		t.Fatal("Unknown native platform accepted")
	}
}

func TestNativeFileListScriptParsesOnItsOperatingSystem(t *testing.T) {
	switch runtime.GOOS {
	case "darwin":
		command, err := nativeFileListCommand(context.Background(), "darwin", []string{"/fixture"})
		if err != nil {
			t.Fatal(err)
		}
		output, err := exec.Command("osacompile", "-o", filepath.Join(t.TempDir(), "clipboard.scpt"), "-e", command.Args[2]).CombinedOutput()
		if err != nil {
			t.Fatalf("AppleScript syntax: %v: %s", err, output)
		}
	case "windows":
		command, err := nativeFileListCommand(context.Background(), "windows", []string{`C:\fixture`})
		if err != nil {
			t.Fatal(err)
		}
		// Parse only; do not mutate the CI runner clipboard.
		parser := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:PHONEPAD_CLIPBOARD_SCRIPT,[ref]$tokens,[ref]$errors); if ($errors) { Write-Error ($errors | Out-String); exit 1 }`)
		parser.Env = append(os.Environ(), "PHONEPAD_CLIPBOARD_SCRIPT="+command.Args[len(command.Args)-1])
		output, err := parser.CombinedOutput()
		if err != nil {
			t.Fatalf("PowerShell syntax: %v: %s", err, output)
		}
	default:
		t.Skip("Native script validation runs on Mac and Windows CI")
	}
}
