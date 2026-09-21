# P01A, fallback literal por clipboard y límites legacy

Fecha: 2026-09-20

Este bloque sigue al checkpoint `0a8d882` y no tiene commit todavía. Su alcance es backend Linux y pruebas de protocolo. No modifica UI, no instala dependencias, no inicia servicios y no declara cierre físico.

## Alcance maestro

- **P01A.2/P01A.5:** el bloque literal conserva la transacción de hasta 128 KiB, pero un destino sin `EditableText` necesita una ruta explícita que no se convierta silenciosamente en scancodes US ni en `Enter`.
- **P01A.3:** la ruta fallback ofrece el bloque Unicode completo por clipboard; no usa `runeToKey` ni intercambia `?` y `_`.
- **P01A.6:** la ruta puede guardar una representación conocida del clipboard, ofrecer el texto en Wayland o XWayland y restaurar la selección anterior. La espera de 40 ms queda como gracia antes de restauración, nunca como señal de éxito.
- **P01A.7:** el resultado del fallback es `uncertain` con detalle `clipboard_owned`. `clipboard_owned` o `admitted` no se presentan como texto aplicado en una app.

## Implementación

`daemon/internal/input/literal.go` mantiene AT-SPI como primera opción. Si el probe responde `editable_focus_unavailable` o `literal_adapter_unavailable`, existen `wl-copy`/`wl-paste` bajo Wayland o `xclip` bajo X11 y la capacidad explícita `PHONEPAD_CLIPBOARD_FALLBACK_SHORTCUT=ctrl-v` está configurada, publica un target de fallback estable y no dependiente del foco AT-SPI. `LiteralText` ofrece el bloque completo, emite una sola combinación Ctrl+V, mantiene el proveedor vivo sólo durante una ventana acotada y devuelve siempre `uncertain`; sin esa capacidad explícita rechaza el fallback. No se infiere Ctrl+V para una terminal ni para un consumidor desconocido.

El fallback no restaura automáticamente por igualdad de bytes: ni Wayland ni X11 exponen de forma suficiente la identidad del propietario, y una copia externa con el mismo texto no se puede distinguir de la oferta propia. Conserva el contenido ofrecido y deja el estado `uncertain` para una acción visible de la UI. Nunca confunde una solicitud `TARGETS` ni el fin del proceso proveedor con texto aplicado. `ClipboardMu` evita carreras entre las operaciones propias del daemon, pero no se usa como prueba de que una aplicación externa ya pegó. La ruta legacy de `pasteUnicode` conserva su restauración MIME condicionada por la observación de bytes; no es la aceptación del nuevo fallback y queda separada para revisión.

`daemon/internal/input/input.go` amplía el snapshot a `xclip` cuando existe DISPLAY y mantiene la vía Wayland existente. `daemon/internal/server/input_operations.go` ya convierte todo resultado diferente de `dispatched` y `rejected` en `uncertain`, por lo que el fallback no reclama observación del receptor.

El protocolo WebSocket legacy mantiene el límite explícito de 8192 bytes. No se trunca: 2048 y 8192 bytes se aceptan íntegramente y 8193 se rechaza. El contrato literal v2 sigue negociando hasta 128 KiB por HTTP autenticado; no se degrada al frame legacy.

## Verificación

Se ejecutaron con el runtime Go privado:

```text
go test -mod=vendor ./internal/input ./internal/server \
  -run 'TestLiteralFallback|TestLegacyText|TestLiteral|TestParseAction' -count=1
ok
```

Los tests nuevos comprueban el target fallback de 64 caracteres, rechazo antes de tocar clipboard de bloques sobre 128 KiB o con NUL, conservación íntegra de los límites legacy y rechazo sin truncamiento sobre 8192 bytes.

La suite completa y `-race` del checkpoint anterior fueron verificadas con listener local habilitado:

```text
go test -mod=vendor ./internal/input ./internal/server -count=1
go test -race -mod=vendor ./internal/input ./internal/server -count=1
ok en ambos paquetes
```

No se ejecutó un consumidor GTK, navegador, terminal o aplicación iPhone en este bloque. No se comprobó que Ctrl+V sea el atajo adecuado para cada terminal ni que wl-copy/xclip estén instalados en el candidato. Esas pruebas requieren el build compatible y un foco real. Hasta entonces, un recibo `uncertain` se conserva para revisión y no se reintenta automáticamente.

## Laboratorio real aislado

Se ejecutó el laboratorio privado con `GDK_BACKEND=wayland`, bus D-Bus y GNOME/Mutter propios; el proveedor GTK de clipboard se abrió sobre el XWayland privado del laboratorio. La evidencia queda en `/tmp/phonepad-hfr-b7mde5gb/` y declara explícitamente que sólo usa fixtures sintéticos. El editor GTK recibió exactamente los casos de símbolos, español, normalización, graphemes, multilinea, IME y 100 KiB por la ruta AT-SPI (`dispatched/atspi_literal`). El proveedor GTK de clipboard entregó exactamente `text/uri-list`, `x-special/gnome-copied-files` y `application/x-kde4-urilist`, repitió `text/uri-list`, soportó una lectura demorada de 1250 ms y una copia sintética posterior; `ownerReleased` fue verdadero. Esto verifica el consumidor GTK/XWayland y la retención/liberación del proveedor en un display aislado, sin tocar el clipboard personal.

La fixture nueva `tools/hfr/fallback_lab.py` usa un `Gtk.DrawingArea` enfocable, sin `EditableText`, y la sesión Mutter privada envía Ctrl+V por D-Bus en vez de crear un `/dev/uinput` o tocar el desktop personal. La aceptación nueva debe demostrar el contenido exacto recibido tras una lectura lenta y en presencia de una copia externa; la evidencia anterior sólo cubría AT-SPI y por sí sola no cierra este camino. Tampoco permite inferir identidad de propietario cuando otro proceso publica el mismo texto: `wl-paste`/`xclip` exponen tipos y bytes, no una identidad que el daemon pueda comparar. Por eso el fallback mantiene `uncertain`, no trata una lectura de `TARGETS` como consumo y no restaura por igualdad de contenido.

La aceptación opt-in pasó el 2026-09-21 en `/tmp/phonepad-hfr-zkrvrkx7/` con `PHONEPAD_LAB_FALLBACK=1`, `GDK_BACKEND=wayland` y el Go privado. `TestLiteralClipboardFallbackLab` pasó en 10.5 s: el caso `slow` leyó exactamente símbolos, `¿_`, emoji, salto de línea y tabulación después de 1250 ms; `external-same` leyó exactamente la copia del segundo propietario con los mismos bytes; `external-different` leyó exactamente `external-copy-¿_` del segundo propietario. Los tres reports marcan `editableText:false`; los receipts fueron `uncertain` (`clipboard_consumption_unobserved` o `clipboard_offer_ended_before_consumption`). No hubo restauración automática y no se involucró el clipboard personal.

## Pendientes

- Extender la aceptación a navegador/Electron y a terminales sin `EditableText`, con capacidad explícita `ctrl-v` o un atajo negociado; la fixture GTK sin `EditableText` ya cubre lectura lenta, propietario externo y bytes exactos.
- Confirmar Ctrl+V frente a Ctrl+Shift+V por aplicación y conectar una preferencia visible si el destino requiere otro atajo.
- Validar que una copia posterior del usuario no se pierda durante la ventana de restauración y registrar el resultado sin contenido personal.
- Integrar con la UI de repetición/recibos cuando ese worker termine P06; este fallback no toca `control.tsx` ni `native-keyboard.tsx`.
- No hacer commit de este bloque hasta la revisión de backend solicitada por `/root`.
