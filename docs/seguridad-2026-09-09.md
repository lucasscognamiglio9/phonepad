# Verificación de seguridad — 2026-09-09

Instalado: QR aleatorio de 192 bits, un uso, vencimiento 2 minutos; credencial
persistente en cookie Secure/HttpOnly/SameSite Strict; WebSocket sin token en URL.
Migración de credenciales antiguas por Authorization y limpieza de localStorage.
Gateway remoto separado con Host validado y rutas de operador denegadas.
Servicio activo en 127.0.0.1:8080, inicio automático conservado; gateway inactivo.
CA privada fuera de entregables y configuración activa; no se instaló confianza.

Verificado: go test -race ./..., go vet ./..., compilación, seis regresiones JS,
validación de scripts bash, git diff --check. Pruebas nuevas: QR usado/vencido,
origen ajeno, atributos cookie, autenticación cookie, rechazo de token URL,
rechazo de rutas de operador, Host incorrecto y origen no loopback en gateway.

Pendiente: usuario instala Tailscale con sudo e inicia sesión en laptop/iPhone.
Luego activar setup/tailscale.sh y comprobar HTTPS real y Wi-Fi apagado en iPhone.
Tailscale Serve aún no instalado ni probado; script preparado, sintaxis validada.
Video WebRTC entre redes, iOS 26 y controles físicos no verificados.
Widget instalado pero GNOME puede necesitar salir/entrar una vez para cargarlo.
Captura de pantalla requiere autorización local y pestaña abierta; no se ha
implementado captura desatendida ni arranque antes del login.

Acceso remoto no se declara terminado. No garantía de 60 FPS ni seguridad absoluta.
