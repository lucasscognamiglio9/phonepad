# PhonePad Mac y Windows: candidato de instalación

La compilación y las pruebas del servidor pasaron en macOS 15 Apple Silicon y Windows 2025. Los binarios de cada sistema están en los artefactos **phonepad-host-macos-15** y **phonepad-host-windows-2025** del [workflow Host platforms](https://github.com/lucasscognamiglio9/phonepad/actions/workflows/host-platforms.yml). Son candidatos sin firma comercial; una sesión real todavía debe comprobarse en los equipos de destino.

## Preparación en cada computadora

1. Instalar Tailscale, iniciar sesión y habilitar MagicDNS y certificados HTTPS de la tailnet. El iPhone debe estar en la misma tailnet. No usar Funnel.
2. Descargar y extraer el artefacto del sistema. En Mac, abrir `start-mac.command`; en Windows, ejecutar `start-windows.ps1` desde PowerShell. Ambos lanzadores detectan el nombre Tailscale, configuran Serve para PhonePad, inician el servidor y abren la página local de captura. Si Serve ya publica otro servicio en el puerto 443, revisar esa configuración antes de ejecutar el lanzador.
3. En Mac, conceder Accesibilidad al servidor y Grabación de pantalla al navegador; reiniciar el servidor después de conceder Accesibilidad. En Windows, aceptar la selección de pantalla del navegador. En la página local, elegir la pantalla y mantenerla abierta durante el uso.
4. Emparejar el iPhone con la URL privada `https://<nombre-del-equipo>.<tailnet>.ts.net`. Cada host tiene su propio emparejamiento. En PhonePad, agregar el equipo con esa URL y cambiarlo desde el menú del monitor.

La primera instalación debe comprobar video legible, mouse, teclado y dictado, archivos, portapapeles, reconexión y cambio de host. Si algo falla, guardar el mensaje exacto y el diagnóstico de video de la página local; no declarar compatible esa ruta hasta corregirla. El iPhone puede ser el del usuario o el de su amigo. La firma gratuita de la app del amigo es un paso separado en su Mac y no forma parte de estos binarios de host.
