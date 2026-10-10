package devreload

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInjectFlagBeforeHead(t *testing.T) {
	html := []byte("<!doctype html><html><head><title>x</title></head><body><script src=\"app.js\"></script></body></html>")
	out := string(InjectFlag(html))

	if !strings.Contains(out, "__PHONEPAD_DEV__") {
		t.Fatalf("falta el flag dev en la salida:\n%s", out)
	}
	// El flag debe ejecutarse ANTES que app.js: inyectado dentro del <head>,
	// que va antes del <script src=app.js> del body.
	if strings.Index(out, "__PHONEPAD_DEV__") > strings.Index(out, "app.js") {
		t.Fatalf("el flag dev debe ir antes de app.js")
	}
	if strings.Index(out, "__PHONEPAD_DEV__") > strings.Index(out, "</head>") {
		t.Fatalf("el flag dev debe inyectarse dentro del <head>")
	}
}

func TestInjectFlagNoHead(t *testing.T) {
	// Sin </head>: igual debe quedar el flag (prepend), nunca perderse.
	out := string(InjectFlag([]byte("<body>hola</body>")))
	if !strings.Contains(out, "__PHONEPAD_DEV__") {
		t.Fatalf("sin </head> el flag debe agregarse igual:\n%s", out)
	}
}

func TestWatcherDetectsChanges(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.go")
	writeFile(t, a, "package a\n")

	w := NewWatcher([]string{dir}, func(p string) bool { return strings.HasSuffix(p, ".go") })

	if w.Changed() {
		t.Fatal("recién armado el baseline no debería reportar cambios")
	}

	// Modificación (cambia el tamaño → detectable sin depender de la resolución de mtime).
	writeFile(t, a, "package a\n\nvar X = 1\n")
	if !w.Changed() {
		t.Fatal("debería detectar el archivo modificado")
	}
	if w.Changed() {
		t.Fatal("sin cambios nuevos no debería volver a disparar")
	}

	// Archivo nuevo que matchea.
	writeFile(t, filepath.Join(dir, "b.go"), "package a\n")
	if !w.Changed() {
		t.Fatal("debería detectar el archivo nuevo")
	}

	// Archivo que NO matchea el predicado: ignorado.
	writeFile(t, filepath.Join(dir, "c.txt"), "ruido")
	if w.Changed() {
		t.Fatal("un archivo que no matchea no debería disparar")
	}

	// Borrado de un archivo vigilado: también es un cambio.
	if err := os.Remove(a); err != nil {
		t.Fatal(err)
	}
	if !w.Changed() {
		t.Fatal("borrar un archivo vigilado debería disparar")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
