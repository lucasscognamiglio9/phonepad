# P01A.7 — integración UI de recibos y repetición

## Alcance de este checkpoint

Este bloque conecta los controles de `native-keyboard` con el contrato de
acciones con recibo de `0a8d882`. Las acciones especiales, combos explícitos,
Enter y Copiar/Pegar usan `pressAction` cuando el host ofrece protocolo v2;
los hosts anteriores conservan el envío compatible existente. La UI conserva
el borrador mientras el resultado sea `admitted`, `uncertain`, `rejected` o
`cancelled`; sólo limpia el contexto ante `executed` para la pulsación inicial.
Un recibo marcado `replayed` se presenta como incierto y nunca dispara otra
acción.

Las flechas visibles son la única whitelist repetible. El retardo inicial es
350 ms y el intervalo es 70 ms, valores centralizados junto al catálogo de
acciones para que la política sea revisable. Enter, Escape, Tab, portapapeles
y combinaciones con modificadores siguen siendo de una sola pulsación. El
release cancela la operación y suprime el `onPress` posterior del mismo gesto;
la accesibilidad puede activar `onPress` aislado una sola vez. Blur, ocultar,
desconectar, revocar permisos, rotar o cambiar de ventana cancelan la
repetición pendiente. No se hace replay al reconectar.

## Evidencia automatizada

- `mobile/tests/action-ui.test.cjs`: estados `admitted`, `executed`,
  `uncertain` y `rejected`; recibo demorado; no replay ante incertidumbre;
  secuencia press/repeat/cancel; release sin doble evento; activación
  accesible aislada; cancelación por rotación y revocación; recibo tardío
  `*_after_cancel` visible sin borrar el borrador/contexto nuevo ni repetir la
  acción anterior.
- `mobile/tests/composer.test.cjs`: 30 casos existentes, incluyendo borrador
  preservado cuando una acción queda bloqueada o falla.
- `npm run typecheck`: aprobado.
- `node --test --test-isolation=none tests/action-ui.test.cjs`: 7/7 aprobado.

La aceptación física de recibos remotos, foco, release y terminales queda
pendiente del candidato nativo y del laboratorio P01A. Este documento no
declara cierre físico de P01A.7.
