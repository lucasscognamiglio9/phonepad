# PhonePad

Usá tu iPhone como mouse, teclado y pantalla remota de tu computadora.

https://github.com/user-attachments/assets/03121b01-74e9-431f-ac3c-bf9a1dab97cc

Demo animada de 22 segundos de la interfaz actual en Linux. [Descargar el video](media/phonepad-demo.mp4).

## Qué hace

- Mueve el cursor, hace scroll y transmite gestos multitáctiles.
- Envía texto, dictado y atajos de teclado a la computadora.
- Muestra la pantalla en vertical y horizontal.
- Envía fotos y archivos. Puede pegarlos en la aplicación que tenga el foco y acepte ese contenido.

Los gestos del escritorio dependen del sistema.

## Disponibilidad

PhonePad está en pruebas. La app para iPhone requiere instalación y firma manual; todavía no está en la App Store.

Linux con GNOME es el entorno principal de desarrollo. Hay candidatos compilados para Mac Apple Silicon y Windows x64; sus sesiones en equipos reales siguen pendientes de validación.

[Instalación y requisitos](docs/instalacion.md).

## Tecnologías

| Componente | Tecnologías |
| --- | --- |
| App de iPhone | React Native, Expo y TypeScript |
| Servidor de la computadora | Go |
| Video | WebRTC; Python, GStreamer y PipeWire en Linux |
| Gestos en Linux | libinput y uinput |
| Conexión entre equipos | Tailscale y HTTPS |

[Estructura y desarrollo](docs/desarrollo.md).

## Problemas e ideas

Usá [Issues](https://github.com/lucasscognamiglio9/phonepad/issues) para reportar problemas o proponer funciones. Incluí el sistema de la computadora y la versión de iOS.
