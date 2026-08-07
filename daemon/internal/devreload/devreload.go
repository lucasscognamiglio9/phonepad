// Package devreload contiene la lógica del modo desarrollo (hot-reload) de
// phonepad: inyectar el flag dev en el HTML servido y detectar cambios de
// archivos por polling de mtime+tamaño. Es lógica pura y testeable; el glue de
// proceso (servir desde disco, push de reload, recompilar+re-exec) vive en main.
//
// Todo el modo dev se activa con la env var PHONEPAD_DEV_SRC; sin ella el daemon
// es producción pura (embed + service worker), así que este paquete no se usa.
package devreload

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
)

// devSnippet se inyecta en el <head> del index servido en dev. La PWA lee este
// flag para desregistrar el service worker (ver siempre lo último, sin cache) y
// para recargarse sola cuando llega {"t":"reload"} por el WS.
var devSnippet = []byte("<script>window.__PHONEPAD_DEV__=true;</script>")

// KillSwitchSW es el service worker que sirve el modo dev en /sw.js. El browser
// revalida el script del SW SALTEANDO el cache del propio SW, así detecta que
// cambió aunque la página venga de un SW de prod cacheado. Al activarse borra
// todos los caches, se desregistra y recarga los clientes → la próxima carga
// viene fresca del daemon dev (sin cache, con el flag dev). Resuelve la
// transición prod→dev sin tocar el celular.
var KillSwitchSW = []byte(`// phonepad DEV: service worker de autodestrucción (limpia el SW de prod).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll()) c.navigate(c.url);
  })());
});
`)

// InjectFlag inserta el flag dev en el <head> del HTML (antes de </head>, así
// corre antes que app.js). Si no hay </head>, lo antepone para nunca perderlo.
func InjectFlag(html []byte) []byte {
	marker := []byte("</head>")
	i := bytes.Index(html, marker)
	if i < 0 {
		return append(append([]byte{}, devSnippet...), html...)
	}
	out := make([]byte, 0, len(html)+len(devSnippet))
	out = append(out, html[:i]...)
	out = append(out, devSnippet...)
	out = append(out, html[i:]...)
	return out
}

// Watcher detecta cambios bajo un conjunto de raíces (recursivo) en los archivos
// que matchean un predicado. Compara mtime+tamaño contra el último snapshot, así
// no depende de la resolución de mtime del filesystem para cambios de contenido.
type Watcher struct {
	roots []string
	match func(path string) bool
	last  map[string]fileStamp
}

type fileStamp struct {
	modUnixNano int64
	size        int64
}

// NewWatcher arma el watcher y toma el snapshot inicial, de modo que el primer
// Changed() compare contra el estado actual (no dispara espurio al arrancar).
func NewWatcher(roots []string, match func(path string) bool) *Watcher {
	w := &Watcher{roots: roots, match: match}
	w.last = w.scan()
	return w
}

// Changed escanea las raíces y devuelve true si algún archivo vigilado se
// agregó, modificó o borró desde el último scan. Actualiza el snapshot.
func (w *Watcher) Changed() bool {
	cur := w.scan()
	changed := len(cur) != len(w.last)
	if !changed {
		for path, st := range cur {
			prev, ok := w.last[path]
			if !ok || prev != st {
				changed = true
				break
			}
		}
	}
	w.last = cur
	return changed
}

func (w *Watcher) scan() map[string]fileStamp {
	out := make(map[string]fileStamp)
	for _, root := range w.roots {
		// WalkDir ignora errores por archivo (carpetas que aparecen/desaparecen
		// durante un build) para no romper el watcher por una carrera transitoria.
		filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				// Podar árboles pesados que nunca cambian en dev: escanearlos cada
				// tick (vendor tiene miles de .go) sería caro y al pedo.
				switch d.Name() {
				case "vendor", ".git", "node_modules":
					return filepath.SkipDir
				}
				return nil
			}
			if !w.match(path) {
				return nil
			}
			if info, err := d.Info(); err == nil {
				out[path] = fileStamp{info.ModTime().UnixNano(), info.Size()}
			}
			return nil
		})
	}
	return out
}

// ReadInjected lee index.html de fsys y le inyecta el flag dev. Helper para el
// handler de dev del server.
func ReadInjected(fsys fs.FS, name string) ([]byte, error) {
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, err
	}
	return InjectFlag(b), nil
}
