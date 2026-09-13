# Phonepad

Control remoto de Linux desde el teléfono: trackpad multitáctil, teclado y
transmisión del escritorio mediante WebRTC. El cliente principal para iPhone
está en `mobile/`: React Native / Expo, teclado del sistema y Liquid Glass.
El daemon Go conserva también un cliente web y el flujo de captura del navegador.

## Estado actual

- App iOS nativa build 4, actualizaciones compatibles por EAS Update, canal `personal`.
- Cursor y video WebRTC; el teclado flota sobre la transmisión sin reducir su contenedor.
- Contactos multitáctiles interpretados por libinput; cancelación sin clic y limpieza al desconectar.
- Cámara, Fotos y Archivos llegan a la laptop; se prepara el portapapeles y se ofrece pegar explícitamente.
- Return del teclado agrega una línea (Shift+Enter remoto). El Enter del campo envía.
- Flechas y modificadores aparecen en Teclas extra; Copiar/Pegar, Esc y Tab tienen etiquetas visibles.

Documentación actual: [app iPhone](mobile/README.md), [controles](docs/control-ux.md),
[verificación del 12 de septiembre](docs/verificacion-2026-09-12.md).
Los informes anteriores conservan pruebas y decisiones históricas; las mediciones
locales de FPS no equivalen a cuadros presentados en el iPhone.

## Estructura

- `mobile/`: cliente iPhone, plugins nativos, build y pruebas.
- `daemon/`: servidor Go, autenticación, input Linux y cliente web alternativo.
- `setup/preview/`: captura y transmisión Linux; ver sus restricciones operativas.
- `setup/`: servicios de usuario, instalación y actualización reversible.
- `tests/`, `tools/`: regresiones y diagnósticos reproducibles. Los experimentos HFR requieren aislamiento.

## Verificar el cliente nativo

```sh
cd mobile
npm ci
npm run typecheck
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

Los artefactos, cachés, dependencias y credenciales locales quedan fuera de Git.
El host personal de conexión se configura en `mobile/src/lib/connection.ts`.
No incluir claves, pairing ni archivos `.env` en commits o paquetes.

## Cliente web y configuración del daemon

Las secciones siguientes describen el cliente web alternativo y el flujo de
captura mediante navegador. Para la app nativa y captura instalada, usar los
vínculos anteriores.

## Ejecutar

Linux amd64: usar el binario `phonepad` del paquete. Desde fuente, Go 1.26+:

```bash
cd daemon
go build -mod=vendor -o ../phonepad .
cd ..
./phonepad --demo --port 8443
```

Abrir `https://localhost:8443/pair`. La demo usa el servidor real con un inyector
que no controla el sistema; la UI muestra **DEMO · sin control físico**. El QR
local permite probar emparejamiento en otro navegador de la misma laptop. Para
probar desde el teléfono, agregar `--bind IP_PRIVADA_DE_LA_LAPTOP`.

Sin `--demo`, requiere `/dev/uinput` accesible como usuario. El setup original
instala la regla udev y wl-clipboard en Debian/Ubuntu:

```bash
sudo bash setup/setup.sh
# cerrar sesión y volver a entrar si cambia la pertenencia al grupo input
./phonepad --bind IP_PRIVADA_DE_LA_LAPTOP
```

El binario arranca en **127.0.0.1** por defecto. `--bind lan` habilita escucha
IPv4 para LAN y loopback, con rechazo de clientes de IP pública antes de
procesar rutas; el control sigue exigiendo token. `--advertise-host equipo.local`
usa un nombre mDNS estable aunque cambie la IP. Una IP privada explícita sigue
disponible y conserva el listener loopback de operador. No abrir puertos en el router.
Detener con Ctrl+C o con el toggle/servicio si se instala.

Para iPhone, seguir [HTTPS confiable y prueba física](docs/iphone.md). Aceptar
una advertencia de certificado no garantiza PWA/WebSocket en Safari. Se admiten
`--tls-cert` y `--tls-key`. Para acceso entre redes se usa Tailscale Serve con
certificado público y un gateway separado. No instalar una CA privada en iOS.

## Usar

1. En la laptop abrir `/pair`, escanear el QR y esperar **conectado** en el cel.
2. Un dedo mueve el cursor; libinput interpreta tap, drag y gestos con dos/tres
   dedos. Hereda preferencias del escritorio. **Teclado** abre teclas y entrada
   nativa. **Pausar** cierra el control; **Reanudar** vuelve a conectarlo.
3. Para ver el escritorio: en la laptop abrir `/share`, elegir una pantalla o
   ventana y autorizar la captura. En el cel tocar **Ver escritorio**.
4. Video arriba y pad abajo en vertical; lado a lado en horizontal. **Ampliar**
   aumenta la vista 2× con desplazamiento. El video no es un mapa de clics:
   manejar el cursor desde el pad conserva gestos nativos y evita problemas de
   escalado/múltiples monitores.
5. **Dejar de compartir** corta video. Para detener todo, apagar Phonepad.

Solo un cliente de control y uno de video. Otra sesión válida reemplaza la
anterior; la anterior no intenta robar el control de nuevo. Tras cortes el
control reconecta; cerrar/reabrir la vista renegocia el video. Bloquear el
celular pausa la sesión y limpia contactos. Rotar la pantalla cancela el gesto
actual para evitar saltos por cambio de tamaño.

## Servicio opcional

Instalar una vez como servicio de usuario y botón GNOME 50:

```bash
PHONEPAD_PREBUILT=/ruta/al/binario/phonepad bash setup/install.sh --always-on
```

Sin PHONEPAD_PREBUILT compila con Go disponible en PATH. Conserva pairing y
service.env existentes. Una instalación nueva escucha solo en loopback. El servicio usa el binario
embebido, sin watchers de desarrollo. --always-on habilita inicio al login.
El botón permite encender/apagar, mostrar QR, compartir escritorio y cambiar
inicio automático. En Wayland puede requerir cerrar sesión y entrar una vez
para cargar una extensión nueva; instalarla no cierra la sesión del usuario.

`~/.config/phonepad/service.env`:

```ini
PHONEPAD_BIND=127.0.0.1
PHONEPAD_HOST=localhost
PHONEPAD_GATEWAY_PORT=8081
PHONEPAD_PUBLIC_URL=https://EQUIPO.TAILNET.ts.net
```

Activar el gateway después de instalar Tailscale: `bash setup/tailscale.sh`.
El QR local contiene una invitación de un solo uso que vence en dos minutos.
La sesión usa una cookie Secure, HttpOnly y SameSite=Strict. Reiniciar el
servicio conserva la identidad. Borrar datos del navegador o revocar el token
requiere nueva vinculación. La prueba física entre redes sigue pendiente.

## Rendimiento de video

Tres objetivos seleccionables antes de capturar: 1080p/60 (12 Mbps máximo),
720p/60 (6 Mbps) y 720p/30 (3 Mbps). Se solicita preservar cuadros por segundo
cuando el navegador adapta calidad. Un objetivo no garantiza que el dispositivo
lo sostenga. WebRTC elige codec interoperable y adapta a la red; no se fuerza
H.264. En navegadores compatibles se sugiere búfer de recepción de 20 ms, cuyo
valor real sigue bajo control del navegador.

La vista de laptop permite guardar diagnóstico JSON: captura real, resolución
emitida, FPS, bitrate, codec, costo medio de codificación/decodificación,
limitación reportada y RTT/búfer. No contiene token ni SDP. Para decidir cambios
de arquitectura usar mediciones del escritorio y del iPhone, no solo canvas.

## Pairing y revocación

Token persistente en `~/.config/phonepad/pairing.json` (0600). El QR contiene una
invitación de un solo uso con vencimiento de dos minutos; no compartirlo. `/pair`, `/qr.svg`, `/events`, `/api/pair-info` y
`/share` se restringen a loopback. WebSocket valida token y origen. Cambiar
`XDG_CONFIG_HOME` permite pruebas aisladas sin tocar el pairing habitual.

Con el daemon detenido, `./phonepad --rotate-token` revoca el token. Reiniciar
y reescanear. No rotar mientras el proceso anterior sigue usando su credencial.

## Verificar

```bash
cd daemon
go test -mod=vendor ./...
go test -mod=vendor -race ./...
go vet -mod=vendor ./...
go build -mod=vendor ./...
cd ..
node --test tests/client.test.cjs
```

Go cubre parsing, FIFO, reset, persistencia, revocación, heartbeats y relay de
video (auth, origen, oferta/respuesta, desconexión). JS cubre handshake, pausa,
contactos, socket viejo, reemplazo de cliente y backpressure. Ninguno sustituye
la [prueba física](docs/iphone.md).

## Límites

- WebRTC sin STUN/TURN: redes aisladas, NAT y Wi-Fi con aislamiento de clientes
  pueden impedir video. No hay servidor remoto ni costo operativo de servicio.
- Captura depende del navegador de laptop y del portal Linux. Necesita una
  pestaña abierta y permiso cada vez; no se enciende sola en segundo plano.
- RTT mostrado es ida/vuelta de control. FPS/resolución son del receptor; no son
  una medición del retraso visual extremo a extremo.
- ASCII usa keymap US. Unicode usa wl-copy + Ctrl+V; en terminales que requieren
  Ctrl+Shift+V hay una limitación conocida. No se garantiza texto en todos los
  layouts ni paridad de gestos fuera de GNOME/libinput.
- Dictado depende de Web Speech y puede usar servicios externos del navegador.
  Para uso completamente local, no activar Voz. Disponibilidad varía por navegador.
- La instalación de PWA y conservación del token entre Safari y modo instalado
  requieren comprobación en el dispositivo concreto.
