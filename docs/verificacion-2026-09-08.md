# Evidencia de esta revisión — 2026-09-08

Base: repositorio público lucasscognamiglio9/phonepad, commit a7395a7. Copia
independiente, rama improve/remote-desktop. Sin push ni modificación del remoto.

## Comprobado

- Go 1.26: `go test ./...`, `go test -race ./...`, `go vet ./...`, `go build ./...`.
  Incluye tests nuevos de relay: acceso local, token, origen externo rechazado,
  oferta/respuesta y aviso de corte. Las primeras pruebas de sockets fallaron
  por el sandbox; al habilitar conexiones locales pasaron.
- Node: 4/4 regresiones de cliente pasan: no enviar antes del handshake, limpiar
  contactos y tolerar cierre de socket viejo, detener reconexión tras reemplazo,
  cerrar el transporte si acumula más de 64 KiB de entrada.
- Chromium en navegador real de prueba: URL limpia después de pairing, conectado,
  Pausar → desconectado, Reanudar → conectado; offline → reconectando y online →
  conectado. Sin errores JS registrados en las vistas comprobadas.
- Dos Chromium locales, emisor con **canvas animado de prueba**: video WebRTC
  recibido a 1280×720, ~29 fps. Pantallas 390×844 y 844×390; video/pad visibles.
  Detener emisión quita `srcObject` del receptor y muestra el corte. Esto prueba
  señalización, codificación, transporte y decodificación; NO captura de Linux.
- Daemon real iniciado sin root: creó phonepad-keyboard y phonepad-touchpad,
  registrados en /proc/bus/input/devices. No se modificó udev ni el sistema.
- Portal org.freedesktop.portal.ScreenCast responde AvailableSourceTypes=7;
  socket PipeWire presente. `getDisplayMedia` existe en el navegador y abrió
  selección; no se obtuvo una captura final autorizada (cancelada/sin permiso).
- Script de certificados ejecutado con CA de prueba aislada; OpenSSL verificó
  cadena e IP SAN. No se instaló esa CA en ningún dispositivo.

## No comprobado / no afirmar todavía

- Recepción de eventos por GNOME, movimiento real del cursor y gestos físicos.
  Leer event14 del touchpad virtual requirió un permiso no disponible. No se
  usó root ni se enviaron teclas sin poder asegurar una ventana de destino.
- Captura completa de escritorio Linux, latencia visual LAN, cambio de monitor,
  HiDPI real y uso simultáneo de video + gestos desde un teléfono físico.
- Safari/iPhone físico, teclado virtual iOS, confianza TLS, PWA instalada,
  persistencia de token, bloqueo/desbloqueo y reconexión física del Wi-Fi.
- Instalador/toggle GNOME en esta máquina; se conservó y ajustó su configuración
  de bind/TLS, sin instalarlo durante esta revisión.

## Demo reproducible

1. Ejecutar el binario con `--demo --port 8443`; usar un XDG_CONFIG_HOME aislado.
2. Abrir `/pair` y su QR en otro navegador para revisar control sin input físico.
3. Abrir el archivo `demo-target.html` del paquete en la laptop.
4. En `/share` elegir esa ventana, o pantalla completa, con permiso explícito.
5. En el receptor tocar Ver escritorio: reloj y figura deben moverse de verdad.
6. Para teclado/cursor reales reiniciar SIN `--demo`, en entorno con uinput,
   enfocar el campo de la demo y seguir docs/iphone.md. No confundir ambos modos.

La fuente canvas usada en la prueba automatizada fue inyectada exclusivamente
en el navegador de test, no está como fallback oculto en el producto.
