# Seguridad

PhonePad está en pruebas. Cada versión requiere revisión antes de distribuir binarios.

Usá HTTPS y una red privada de Tailscale. La configuración de referencia usa Serve; no expongas PhonePad mediante Funnel ni un proxy público. El servidor y los procesos locales de la computadora deben ser de confianza.

En Linux se autoriza un nodo concreto del iPhone. Los lanzadores de Mac y Windows autorizan dispositivos de la misma cuenta Tailscale. Un dispositivo autorizado puede controlar el escritorio, enviar archivos y acceder al portapapeles. Para cortar el acceso, detené el servidor o revocá el dispositivo en Tailscale. Para una sesión de navegador emparejada por QR, rotá el token y reiniciá el servidor.

La captura necesita autorización del sistema. Cerrá la página de captura o detené el servicio para dejar de compartir pantalla. La revocación independiente del permiso de video todavía no está implementada.

No incluyas tokens, certificados, pairing, archivos personales ni capturas privadas en Issues. Para una vulnerabilidad, usá el [reporte privado de GitHub](https://github.com/lucasscognamiglio9/phonepad/security/advisories/new) cuando esté habilitado. Ese canal debe activarse al abrir el repositorio.

Los avisos de dependencias pendientes y el alcance de las comprobaciones están en la [auditoría](docs/auditoria-seguridad.md).
