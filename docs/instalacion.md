# Instalación y requisitos

Se publica el código en pruebas. Todavía no hay una descarga estable ni una versión en la App Store.

## Requisitos

- Un iPhone con PhonePad instalado y firmado.
- Una computadora encendida con el servidor de PhonePad.
- Tailscale en ambos equipos, con acceso a la misma red privada.
- Permiso para controlar y capturar la pantalla de la computadora.

La firma gratuita de iPhone vence a los siete días y necesita renovación. [Apple describe los límites de la firma personal](https://developer.apple.com/help/account/basics/about-your-developer-account).

## Computadoras

| Sistema | Estado y preparación |
| --- | --- |
| Linux con GNOME | Entorno principal. Requiere permisos de entrada y autorización de captura. |
| Mac Apple Silicon | Candidato compilado. El lanzador es `start-mac.command`. Requiere Accesibilidad para el servidor y Grabación de pantalla para el navegador. |
| Windows x64 | Candidato compilado. El lanzador es `start-windows.cmd`. La captura se autoriza en el navegador. |

Los candidatos de Mac y Windows necesitan comprobar una sesión completa en dispositivos reales. Sus capturas usan una página del navegador que permanece abierta durante el uso.

Los paquetes candidatos de esta revisión se identifican por su commit y checksum. No incluyen cuentas, perfiles Apple ni un canal personal de actualizaciones. La IPA requiere firma local antes de instalarse.

## Preparar Linux desde el código

Los scripts actuales están orientados a GNOME en Ubuntu. El video requiere GStreamer, Python GI, PipeWire y un encoder disponible; su preparación depende del hardware y la versión del sistema.

1. Instalá Go 1.26.9 o posterior y las dependencias de video. Revisá `setup/install-video-runtime.sh` antes de ejecutarlo: prepara un runtime de Ubuntu amd64 con VA-API para Intel.
2. Ejecutá `sudo bash setup/setup.sh`. Crea el grupo `phonepad` con acceso a `/dev/uinput`. Cerrá sesión y volvé a entrar para aplicar el grupo.
3. Ejecutá `bash setup/install.sh` como tu usuario. Instala el servidor y los módulos de video, conserva la configuración existente e inicia servicios de usuario.
4. Con Tailscale conectado en ambos equipos, obtené el `ID` estable del iPhone en `Peer` dentro de `tailscale status --json`. Ejecutá `bash setup/tailscale.sh ID_ESTABLE_DEL_IPHONE`. El script configura Serve y autoriza ese nodo; rechaza una configuración Serve existente para no reemplazar otro servicio.
5. Agregá en PhonePad la dirección HTTPS que muestra el script. Abrí monitor para autorizar la captura del escritorio cuando el sistema lo solicite.

Estos pasos necesitan validación en una instalación nueva. No se ejecutaron sobre el escritorio durante la auditoría.

## Usar PhonePad con un equipo preparado

1. Iniciá el servidor en la computadora y conectá Tailscale en ambos equipos.
2. Agregá la dirección HTTPS privada de la computadora desde el selector de equipos de PhonePad.
3. Mové el cursor desde el teléfono. Para ver la pantalla, abrí el menú, elegí monitor y seleccioná el equipo.
4. Abrí el teclado desde el menú o usá **+** para enviar una foto o un archivo.

El envío y el pegado necesitan los permisos correspondientes. La aplicación destino debe tener el foco y aceptar el contenido.
