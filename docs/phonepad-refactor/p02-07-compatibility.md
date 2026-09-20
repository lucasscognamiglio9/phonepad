# P02.7B: compatibilidad entre versiones

Fecha: 20/09/2026.

Este bloque prueba las dos combinaciones que deben coexistir durante la
migración del protocolo de sesión.

| Cliente | Servidor | Saludo | Resultado comprobado |
| --- | --- | --- | --- |
| `Connection` de `adab7c77` | Go actual | `/ws`, perfil legacy | conexión, movimiento, click, stop y reconexión sin repetir eventos |
| `Connection` actual | Go de `adab7c77` | `/ws?protocol=2`, respuesta legacy `{"t":"ok"}` | conexión, movimiento, click, stop y reconexión sin repetir eventos |

El servidor viejo ignora la query `protocol=2` y no anuncia capacidades. El
cliente actual interpreta ese saludo como `legacy-v1`. En esa dirección la
transferencia literal queda sin capacidades, falla localmente y no hace una
petición a `/api/input`; tampoco se transforma el texto en comandos de teclas.
El cliente viejo no necesita leer los campos adicionales del saludo v2, por lo
que conserva el ruteo legacy contra el servidor actual.

La prueba actual vive en
`daemon/internal/server/compat_interop_test.go`. Para el servidor viejo copia
`tools/refactor/p02_compat_old_server_test.go` dentro de un archivo temporal
obtenido con `git archive adab7c77`. El cliente Node de
`tools/refactor/p02_compat_connection.cjs` transpila el `connection.ts` del
árbol indicado en cada caso y abre el fetch y el WebSocket reales.

Ambos casos usan `httptest.NewTLSServer`, escriben el certificado efímero en
un PEM temporal y lo pasan mediante `NODE_EXTRA_CA_CERTS`. El cliente envía
`__Host-phonepad=tok` explícitamente en HTTP y WebSocket. No se desactiva la
verificación TLS. El inyector de cada proceso Go registra deltas y botones; la
aserción exige exactamente un movimiento y dos bordes de botón por conexión,
sin replay después de reconectar.

Para repetir el chequeo focal:

```sh
./tools/refactor/p02_compat_run.sh
```

El runner recrea `outputs/temporal/p02-07-compat/adab7c77` desde el commit
estable y ejecuta sólo `TestP02Compatibility` con `-mod=vendor` y
`GOPROXY=off`. La corrida del 20/09/2026 pasó las dos subpruebas en 12,651 s.

La prueba no afirma compatibilidad de una IPA, Hermes, Expo nativo, uinput,
Wayland, captura de video o RTC. Tampoco cubre el pairing ni una migración de
permisos. Esas rutas requieren sus propios proveedores y pruebas de dispositivo.
