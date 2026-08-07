# ADR 0002 — Texto Unicode por portapapeles (no wtype) en GNOME Wayland

Estado: aceptado · Fecha: 2026-06-01

## Contexto

El path de texto (`Injector.Text`) delegaba en `wtype`, que habla
`zwp_virtual_keyboard_v1`. **GNOME Mutter no implementa ese protocolo**, así que
`wtype` falla siempre ("Compositor does not support the virtual keyboard
protocol"). Resultado: ni el teclado ni el dictado por voz escribían nada (el STT
inyecta su resultado por el mismo `Text()`). El resto (mouse, clicks, teclas
especiales, combos) andaba porque va por `uinput` (kernel-level).

uinput emite scancodes, no codepoints: el carácter final lo decide el keymap XKB
del sistema, que no controlamos. No hay forma de "subir un keymap propio" por
uinput — eso es justo lo que hace el protocolo virtual-keyboard ausente.

## Decisión

Estrategia **híbrida**, sin dependencias nuevas (boceto en `internal/input`):

- El ASCII del layout US se emite por **keycode uinput** (reusa `runeToKey`),
  rápido y sin tocar el portapapeles.
- Las runes Unicode (acentos/ñ/emoji) se inyectan por **portapapeles**: `wl-copy`
  del fragmento + `Ctrl+V` por uinput, guardando y restaurando el clip. Las
  corridas no-ASCII contiguas se agrupan en un solo paste.

La decisión de reparto vive en `planText(s)`, función pura y testeada; `Text()`
solo ejecuta el plan.

## Consecuencias

- (+) Texto Unicode completo en GNOME Wayland; desbloquea teclado y dictado.
- (+) El caso mayoritario (ASCII, comandos) nunca clobberea el clipboard.
- (+) Cero dependencias nuevas (`wl-clipboard` ya se instala en el setup).
- (−) Límite conocido: en terminales VTE (GNOME Terminal) el paste es
  `Ctrl+Shift+V`, así que ahí el fragmento Unicode no aparece (el ASCII sí).
- (+) Una FIFO interna saca el paste lento del read loop y conserva el orden entre
  Text, teclas especiales, combos y frames táctiles; `Reset` invalida la cola al
  desconectar.
- Alternativas descartadas: `ydotool` (mismo límite de layout, no resuelve
  Unicode, suma un daemon) e IBus codepoint (frágil entre apps).
