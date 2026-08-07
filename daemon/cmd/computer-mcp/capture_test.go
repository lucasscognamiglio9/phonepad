package main

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Regresión: un backend que sale con código 0 SIN escribir el archivo (lo que hace
// gnome-screenshot 41 bajo Wayland) debe dar un error que nombre el backend, no el
// "open ...: no such file or directory" opaco que veía el usuario.
func TestRunCaptureCmd_ExitsZeroNoFile(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "shot.png")
	_, err := runCaptureCmd(tmp, []string{"true"}) // sale 0, no escribe nada
	if err == nil {
		t.Fatal("se esperaba error cuando el backend no produce archivo")
	}
	if !strings.Contains(err.Error(), "sin producir imagen") {
		t.Errorf("error poco descriptivo: %v", err)
	}
}

// Camino feliz: el backend escribe un PNG válido → se decodifica y se devuelve.
func TestRunCaptureCmd_WritesValidPNG(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "shot.png")
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	// runCaptureCmd borra tmp antes de correr el backend, así que emulamos un
	// screenshooter real con `cp` desde un fixture (no escribimos tmp a mano).
	src := filepath.Join(t.TempDir(), "src.png")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	img, err := runCaptureCmd(tmp, []string{"cp", src, tmp})
	if err != nil {
		t.Fatalf("captura válida falló: %v", err)
	}
	if got := img.Bounds(); got.Dx() != 4 || got.Dy() != 3 {
		t.Errorf("dims = %v, want 4x3", got)
	}
}

// El backend que falla (exit != 0) debe propagar el error nombrando el comando.
func TestRunCaptureCmd_NonZeroExit(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "shot.png")
	_, err := runCaptureCmd(tmp, []string{"false"})
	if err == nil || !strings.Contains(err.Error(), "false") {
		t.Errorf("se esperaba error nombrando el backend, got %v", err)
	}
}
