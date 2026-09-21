# P01A, contratos de entrada y recibos

Fecha: 2026-09-20
Checkout: `work/phonepad-refactor`, rama `refactor/p00-baseline`
Alcance: implementación de contratos de entrada, recibos de acciones especiales/combos y transporte móvil. No incluye UI, build nativo, instalación, pruebas físicas, push ni deploy.

## IDs atendidos

Este bloque implementa el tramo de P01A.2 y P01A.7 que faltaba en el código, y deja soporte de contrato para P01A.3, P01A.4 y P01A.5. Los subbloques `p01a-01` a `p01a-05` no se consideran equivalentes a cerrar las tareas maestras.

- **P01A.2:** `operationId`, sesión, fase, secuencia, recibo por acción y estados `executed`, `admitted`, `rejected`, `uncertain` y `cancelled`; deduplicación y consulta local del recibo.
- **P01A.3:** se conserva separado el texto literal del mapa US; special/combo siguen siendo acciones de keymap y sus fallos ya no se reducen silenciosamente a una acción parcial.
- **P01A.4:** un timeout esperando al proveedor se clasifica como `uncertain`; no se reinyecta después de una reconexión.
- **P01A.5:** se mantiene la transacción literal existente para bloques largos, con sus límites negociados, checksum y fragmentos; esta entrega no cambia la ruta literal ni declara aceptación física.
- **P01A.7:** press/repeat/cancel tienen secuencia, deduplicación, cancelación definitiva de repeticiones y recibo distinto de la mera admisión del FIFO.

## Cambios de código

### Daemon

- `daemon/internal/input/contracts.go`: agrega `ActionResult` y la interfaz opcional `ActionExecutor`. Los inyectores antiguos se reportan como `admitted` con `provider_execution_unobserved`.
- `daemon/internal/input/async.go`: agrega operaciones receipt-aware a la misma FIFO que texto, teclas y touch. Una espera interrumpida devuelve `uncertain`; una operación invalidada por `Reset` devuelve `rejected` y nunca se reinyecta.
- `daemon/internal/input/input.go`: `SpecialAction` y `ComboAction` devuelven estado del proveedor. Tecla desconocida, modificador desconocido o teclado no disponible se rechazan. Un fallo de `KeyPress`, `KeyDown` o liberación de modificador queda como incierto y conserva estado para `Reset`.
- `daemon/internal/server/protocol.go`: añade `operationId`, `phase` y `actionSequence`; valida press/repeat/cancel, payload de cancelación, IDs y secuencias sin romper mensajes legacy.
- `daemon/internal/server/server.go`: mantiene operaciones acotadas por `sessionEpoch`, exige press inicial, secuencia exacta para repeat, devuelve recibidos duplicados como `replayed`, rechaza huecos y corta definitivamente repeat en cancelación o incertidumbre. El `cancel` no llama al inyector y sigue permitido para cerrar una operación después de revocar input. El recibo solo se emite después de ejecutar el proveedor o de registrar explícitamente admisión/resultado incierto.

### Mobile

- `mobile/src/lib/protocol.ts`: tipos `ActionCommand`, `ActionReceipt` y validación estricta de recibos.
- `mobile/src/lib/connection.ts`: `pressAction`, `repeatAction`, `cancelAction`, `getActionReceipt` y `waitActionReceipt`. Los repeats usan la siguiente secuencia, cancelación puede cruzar una revocación de input mientras siga la sesión, y `stop`/desconexión limpia operaciones y esperas para impedir replay incierto.

### Corrección de orden y cancelación tardía

El primer diseño reservaba dos repeticiones bajo el mutex, pero permitía que
un proveedor rápido entrara antes de una pulsación inicial aún bloqueada. Ahora
cada secuencia espera el cierre de la anterior antes de llamar al proveedor y
una compuerta de admisión serializa esa decisión con `cancel`;
un duplicado que llega mientras esa secuencia está pendiente espera el mismo
recibo y se marca `replayed`. `cancel` cierra las esperas de las secuencias
futuras y deja la operación en estado terminal `cancelled`, que ningún callback
tardío puede sobrescribir.

Si la pulsación o repetición ya estaba dentro del proveedor cuando llegó
`cancel`, el recibo conserva el resultado observado y añade
`executed_after_cancel`, `admitted_after_cancel` o `uncertain_after_cancel`.
Eso describe un efecto que pudo ocurrir; no afirma que la cancelación lo haya
deshecho. Las repeticiones encoladas reciben `rejected/operation_cancelled` y
no llaman al proveedor.

La evidencia determinista está en
`daemon/internal/server/action_receipts_test.go`:
`TestActionReceiptConcurrentRepeatWaitsForPressProvider` y
`TestActionReceiptCancelStopsQueuedRepeatButPreservesLatePressResult` cubren
proveedor bloqueado/liberado, secuencia FIFO, duplicado pendiente, cancelación
terminal y callback tardío. `go test -race -mod=vendor ./internal/input ./internal/server
-count=1` pasó con el runtime Go privado y listener local habilitado.

## Pruebas y evidencia

Pruebas ejecutadas con el Go privado y cache fuera del checkout:

```text
GOCACHE=/tmp/phonepad-go-cache go test ./internal/input ./internal/server \
  -run 'TestAsyncText_ActionReceipt|TestActionReceipt|TestComboActionReports|TestKeyboardState|Test(Parse|Valid|Route|LiteralHTTP|Input|Async|Permission)' -count=1
ok phonepad/daemon/internal/input
ok phonepad/daemon/internal/server
```

Pruebas móviles dirigidas:

```text
npm run typecheck
npm test -- tests/action-receipts.test.cjs tests/core.test.cjs tests/session-capabilities.test.cjs
3 archivos, todas las pruebas aprobadas
```

Los casos nuevos cubren proveedor demorado, espera interrumpida, `KeyDown` fallido con limpieza, proveedor legacy admitido, press duplicado, repeat duplicado, hueco de secuencia, cancelación y repeat tardío. `action-receipts.test.cjs` cubre envelope v2, recibo válido, recibo malformado, epoch ajeno y cancelación después de revocar input.

La corrida completa `npm test` tiene un fallo ajeno a este bloque: los tests de `composer` y `control-layout` cargan `native-keyboard.tsx` y el fixture no ofrece `useKeyboardState`. Es un cambio concurrente de UI (`mobile/src/components/native-keyboard.tsx` y tests asociados), no una regresión de `connection.ts` o `protocol.ts`. Los otros 16 archivos de esa corrida pasaron.

La suite Go completa no se usa como criterio en este entorno porque sus tests de WebSocket que crean `httptest.NewServer` fallan al abrir listeners IPv6 dentro del sandbox (`listen tcp6 [::1]:0: operation not permitted`). Los tests dirigidos que no necesitan listener pasan.

## Contrato para UI de repetición

1. `const operationId = connection.pressAction({t: 'k', a: 'special', key: 'ArrowLeft'})` o el equivalente `combo`; `null` significa que no se admitió localmente.
2. Mientras el botón esté mantenido, `connection.repeatAction(operationId)` envía `phase: repeat` con secuencia creciente. La UI debe detener el timer en release, hide, rotación, pérdida de foco, desconexión o revocación.
3. En todos esos eventos debe llamar `connection.cancelAction(operationId)` cuando la sesión siga conectada. La cancelación no deshace una tecla ya ejecutada; solo impide trabajo futuro y su recibo puede indicar `repeat_stopped_after_uncertain`.
4. `await connection.waitActionReceipt(operationId)` solo informa el recibo del daemon. `executed` confirma que el proveedor terminó su llamada; `admitted` significa que el proveedor antiguo no permite observar ejecución; `uncertain` no se repite automáticamente.

## Pendientes y límites

- Integrar estos métodos en UI y comprobar manualmente flechas, combos, focus/blur, release, hide, rotación y reconexión.
- Ejecutar con proveedor uinput real para obtener `executed`, y con un candidato compatible instalado para probar rechazo, desconexión y resultado incierto en el equipo físico.
- Repetir la matriz literal `?`, `_`, layouts US/es/latam, límites 2047/2048/2049 y bytes UTF-8, pegado largo íntegro, dictado/revisiones, múltiples fotos, borradores y recuperación. El contrato no sustituye esas pruebas de aplicación.
- El fallback literal para destinos sin `EditableText` queda separado y opt-in;
  su laboratorio GTK/XWayland, lector lento y copia externa están documentados
  en `p01a-clipboard-execution-2026-09-20.md` y en
  `outputs/p01a/clipboard-fallback-2026-09-21`. Siempre devuelve `uncertain`,
  no restaura por igualdad de bytes y no asume Ctrl+V para terminales.
- Construir e instalar un candidato nativo con fingerprint y firma comprobados. Ubuntu+iPhone es la pareja prevista; Mac y Android siguen sin toolchain/firma comprobados.

No se afirma cierre físico, de distribución ni de producción desde estos fixtures.
