# PhonePad para Mac y Windows

Estos paquetes son candidatos. CI compila el servidor y comprueba el código; falta validar permisos, entrada y video en equipos reales.

Necesitás PhonePad instalado y firmado en el iPhone, y Tailscale conectado en ambos equipos con tu cuenta.

1. Extraé el paquete completo. Mac requiere Apple Silicon; Windows requiere x64.
2. En Mac, abrí `start-mac.command`. En Windows, abrí `start-windows.cmd`.
3. El lanzador muestra la dirección HTTPS y abre la página local de captura. Autorizá compartir la pantalla y mantené esa página abierta. Mac también requiere Accesibilidad para controlar el escritorio.
4. Agregá esa dirección desde el selector de equipos de PhonePad.

El binario de Mac tiene firma ad hoc y no está notarizado. Los paquetes no incluyen una cuenta Apple ni credenciales Tailscale. El lanzador autoriza dispositivos de tu misma cuenta Tailscale y rechaza reemplazar un servicio Serve ajeno.

Para terminar, detené el servidor en su terminal y cerrá la página de captura. No expongas el servidor en Internet.

Código y requisitos: https://github.com/lucasscognamiglio9/phonepad
