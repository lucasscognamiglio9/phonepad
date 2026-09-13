# Phonepad seguro en iPhone y entre redes

Estado: protecciones verificadas por pruebas automáticas. Tailscale y la
prueba real con iPhone 17 / iOS 26 siguen pendientes. No instalar una CA
privada ni desactivar la validación TLS del teléfono.

1. Instalar Tailscale en la laptop desde https://tailscale.com/download/linux
   y en iPhone desde App Store. Iniciar sesión con la misma cuenta y activar
   la conexión en ambos. En Linux, `sudo tailscale up` abre el inicio de sesión.
2. Ejecutar `bash setup/tailscale.sh` en el repositorio. Requiere el servicio
   Phonepad actualizado. Configura un gateway restringido en 127.0.0.1:8081
   y Tailscale Serve persistente. Si Tailscale solicita habilitar HTTPS,
   completar su enlace de configuración y repetir el comando.
3. Serve expone Phonepad solo dentro de la red privada de Tailscale; no usar
   Funnel ni abrir puertos del router. El nombre del equipo del certificado
   público aparece en registros de transparencia de certificados.
4. En la laptop, abrir la página local `/pair` desde el botón Phonepad.
   Escanear el QR con Safari antes de dos minutos. Es de un solo uso.
   La dirección del iPhone debe ser `https://EQUIPO.TAILNET.ts.net` y funcionar
   sin advertencias. La cookie de sesión no queda disponible para JavaScript.
5. Agregar a inicio y verificar allí la vinculación: Safari y la aplicación
   instalada pueden mantener almacenamiento separado. Luego cerrar/reabrir y
   reiniciar Phonepad para confirmar que no pide otro QR.
6. Desactivar Wi-Fi en iPhone y probar con datos móviles, Tailscale conectado.
   La laptop debe seguir encendida, conectada y con su sesión iniciada.
   Suspender la laptop interrumpe el acceso; el servicio no la despierta.

El gateway bloquea páginas de operador, QR y publicación de pantalla aunque
el proxy se conecte desde loopback. El servicio local no debe publicarse por
proxy directamente: usar exclusivamente el gateway 8081.

El control y la señalización viajan por Tailscale. El video sigue usando
WebRTC entre navegadores, sin TURN configurado: la conectividad de sus
candidatos a través de la VPN debe validarse en Safari. HTTPS funcionando no
prueba que el video funcione entre redes. Si falla, hace falta un transporte
multimedia compatible (por ejemplo TURN privado autenticado o emisor nativo).
La captura actual requiere autorizar pantalla en la laptop cada sesión de
captura; la vinculación persistente no elimina ese permiso del navegador.

Para revocar Phonepad: detener servicio, ejecutar `phonepad --rotate-token`
y reiniciarlo. Para revocar un equipo Tailscale, retirarlo de la consola de
Tailscale. No deshabilitar globalmente la caducidad de credenciales.

## Prueba física, 10 minutos

- En un editor vacío de la laptop: mover cursor, tap, arrastre, scroll con dos
  dedos y pinch en una app compatible. Tres dedos: GNOME overview/escritorios.
  Las preferencias de libinput/GNOME determinan tap y scroll natural.
- Escribir `Phonepad 123`, después `café ñ 🚀`. Probar Enter, borrar, flechas y
  Ctrl+A en ese editor. Unicode en terminal sigue necesitando otro atajo de
  pegado; no usarlo como única prueba de texto.
- Pausar: ningún toque debe controlar la laptop. Reanudar: control disponible.
- Apagar Wi-Fi 10 segundos, encenderlo y comprobar reconexión sin reescanear.
  Bloquear/desbloquear el iPhone; ningún dedo ni tecla debe quedar activo.
- En la laptop abrir `/share`, pulsar **Elegir pantalla y compartir** y elegir
  el monitor en el selector. Mantener esa pestaña abierta.
- En el teléfono pulsar **Ver escritorio**. Mover una ventana o reproducir una
  animación en la laptop: comprobar movimiento continuo, texto legible y cursor.
  Probar vertical, horizontal, **Ampliar** y desplazamiento de la vista. El
  touchpad separado conserva los gestos nativos; tocar el video no hace clic
  absoluto en el escritorio.
- **Dejar de compartir** en la laptop debe quitar inmediatamente el video del
  teléfono. El touchpad continúa; **Pausar** o apagar el daemon detienen control.
- Para latencia real, filmar juntos laptop y teléfono mientras se mueve una
  ventana. Contar la diferencia de cuadros. Objetivo de aceptación inicial:
  movimiento fluido y retraso visual menor a 200 ms en Wi-Fi local estable.
  Los “ms de red” del cliente son RTT de control, no latencia extremo a extremo.

Registrar modelo, iOS, navegador/modo instalado, escritorio Linux, resolución,
escalado, FPS durante movimiento, demora visual y el paso exacto que falla.
No enviar el token, QR ni claves en el reporte.

Fuentes: https://tailscale.com/docs/features/tailscale-serve
https://tailscale.com/docs/how-to/set-up-https-certificates
