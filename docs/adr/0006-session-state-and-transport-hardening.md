# ADR 0006 — Estado de sesión y límites del transporte

Estado: aceptado · Fecha: 2026-08-02

## Contexto

Un WebSocket viejo puede terminar su `Read` después de que otro cliente ya lo
reemplazó. Además, un paste Unicode tarda más que un frame táctil y un corte de
red puede dejar un slot MT, un botón o un modificador abajo. Las vistas de QR y
estado tampoco deben ser una API de LAN.

## Decisión

- El server asigna una generación monotónica a cada conexión y comprueba
  generación + puntero bajo un mutex antes de rutear. Cambiar o limpiar la
  conexión hace `Reset`: libera teclas, botones y slots MT, e invalida la FIFO.
- `NewAsyncText` es ahora un serializador de todas las acciones. Un epoch hace
  que los mensajes pendientes de la sesión vieja se descarten; una operación ya
  iniciada termina antes del barrier de reset.
- `SetReadLimit` y `Parse` acotan el tamaño y validan campos. Los errores de
  escritura uinput se registran con contexto; los writes MT tienen reintentos
  acotados y, si queda un prefijo incierto, el siguiente frame emite un hard
  reset de todos los slots/tool bits.
- El read loop aplica un deadline de inactividad de 15 s (los pings de la PWA lo
  mantienen vivo) y un watchdog independiente envía Ping/Pong cada 5 s con
  timeout de 3 s. Un timeout cierra la conexión por la misma ruta que siempre
  ejecuta `Reset`.
- `/pair`, `/qr.svg`, `/events` y `/api/pair-info` aceptan solo loopback;
  `pair-info` omite el token. La PWA consulta `/api/auth` con
  `Authorization: Bearer` para mostrar un 401 accionable y no reconectar sin fin.

## Consecuencias

- (+) Una sesión reemplazada no puede liberar/arrastrar estado sobre la nueva;
  el compositor recibe fronteras MT limpias.
- (+) La secuencia observable Text/Special/Combo/Touch es FIFO y los límites
  reducen el impacto de frames malformados.
- (−) Una ráfaga que llena la FIFO puede aplicar backpressure al read loop; el
  buffer está dimensionado para el uso humano normal y mantiene la semántica
  explícita de orden.
- (−) El token sigue viajando en la query del handshake WS porque es el
  contrato del navegador; la PWA limpia la URL y las APIs de pairing no lo
  vuelven a exponer.
