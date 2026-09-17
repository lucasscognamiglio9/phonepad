# Estado de ejecución — 17/09/2026

## Checkpoint de cierre por cuota: P01A-03

El usuario pidió detener y dejar todo al día. Bloque de texto literal P01A-02 en `38f3f6a`; bloque de lotes P01A-03 terminado como entrega parcial, documentado en `p01a-03.md`. Once suites móviles, TypeScript, Python, Go race, vet y build aprobados. Evidencia de GTK real aislado para texto y portapapeles en `outputs/p01a-02` y `outputs/p01a-03`, ignorada por Git pero conservada.

**P01A completa no está cerrada.** Próximo bloque: reanudación por archivo/parte y checksum de origen del lote, negociación/revisión de límites y selección; después recibos de acciones/atajos y alternativa para apps sin EditableText. Mantener aceptación física iOS/Android, clipboard sin XWayland, compatibilidad/build nativo y P00.6/P01.6 pendientes. No desplegado ni publicado OTA. No iniciar otra fase hasta que el usuario reanude.

El estado siguiente es histórico y no reemplaza esta pausa.

## Estado vigente: P01A, bloque 3

Selección múltiple conectada a lotes atómicos e idempotentes, con proveedor de lista de archivos validado en GTK/XWayland privado. Ver `p01a-03.md`. Reanudar partes individuales, checksum de origen, acciones/atajos y aceptación física siguen pendientes. El bloque 2 de texto literal queda en commit `38f3f6a`. No desplegado. Continuar sin pausas rutinarias.

## Estado vigente: P01A, bloque 2

Texto literal conectado desde el compositor al endpoint autenticado y al adaptador AT-SPI. Ver `p01a-02.md`. GTK aislado verifica corpus y 100 KiB exactos; pruebas de cliente/servidor pasan. Fase parcial: faltan clipboard alternativo, acciones, lotes y aceptación física. Expo Crypto exige nuevo build nativo. No desplegado.

Autorización vigente: continuar sin pausas rutinarias; el usuario avisa cuándo detener. Conservar checkpoints sin terminar el turno por revisión de cuota. Próximo trabajo: lotes de adjuntos.

## Historial de checkpoints

## Checkpoint vigente: P01A, bloque 1

Borradores protegidos ante rechazo/desconexión y núcleo de transferencia literal hasta 128 KiB probado. Ver `p01a-01.md` y `input-operation-contract.md`. El núcleo todavía no se conecta al transporte ni inyector; no declarar resueltos símbolos, dictado, pegado largo o adjuntos. P01A sigue en curso; los pendientes físicos P00.6/P01.6 también.

Próximo bloque P01A-02: adaptador Linux de texto literal y proveedor de clipboard con resultados explícitos y consumidores lentos, seguido de integración de transporte/recibos. No levantar `maxLength` aisladamente. Conservar `outputs/p01a-01` y los checkpoints anteriores. No se desplegó.

## Historial P01

## Checkpoint vigente: P01 implementada, aceptación física pendiente

P01.1–P01.5 entregadas con pruebas y comparación contra P00. P01.6 cuenta con A/B de encoder real aislado; faltan detalle visual y tráfico/colas extremo a extremo en dispositivo. Ver `p01.md` para resultados, límites y rollback. P00.6 sigue pendiente; no hubo despliegue ni publicación OTA.

Próximo bloque autorizado por fases: P01A, integridad de entrada y adjuntos. Conservar evidencia de `outputs/p00` y `outputs/p01`, ambas ignoradas por Git. Al retomar, usar este checkpoint en lugar de la reanudación histórica P01 que aparece debajo.

## Historial P00

## Checkpoint P00: laboratorio y referencia preservados

Autorizado ejecutar por fases y detenerse entre entregas para revisar cuota. Rama `refactor/p00-baseline`, copia aislada; origen congelado en `adab7c77bc74f0e6e6d9e48bc55d330d7e15e77e`. No se desplegó ni reinició PhonePad. El plan maestro sigue en `../../outputs/PHONEPAD-PLAN-MAESTRO.md` respecto de la raíz de este checkout.

- P00.1 listo: bundle completo, servidor estable, IPA y configuración de servicio con SHA256 en `outputs/p00/baseline`. Copia privada, ignorada por Git.
- P00.2 listo para bitrate: seis escenarios versionados; extracción de RateController sin cambios de comportamiento; comparación contra 2.000 muestras de la clase original. Las reproducciones de entrada permanecen en la auditoría y se convierten en regresiones al ejecutar P01A.
- P00.3 listo: escena determinista con barcode, texto fino, movimiento y modo quality con pausa real; laboratorio GNOME/PipeWire aislado verificado y video preservado.
- P00.4 listo: ocho perfiles en namespaces privados. Se corrigió la contaminación entre perfiles causada por `netem replace`: ahora elimina y crea la disciplina en cada etapa. Es prueba UDP del laboratorio, todavía no sesión WebRTC bajo esos perfiles.
- P00.5 listo para comparación de política y referencia de host: recolector JSON, A/B con igualdad de fixture, recursos inventariados. Las métricas físicas quedan explícitamente pendientes.
- P00.6 parcial: daemon compilado, servidor empaquetado y hashes verificados; tipos y pruebas pasan. No hay nuevo build iOS/Android instalado ni aceptación física de arranque/reconexión. **P00 completa todavía no está cerrada.**

## Evidencia

25 pruebas Python y 6 del laboratorio visual pasan. Pasaron las 10 suites de archivos móviles, las 2 web, TypeScript sin emisión y Go con detector de carreras; daemon compilado con Go 1.26.0. Logs y artefactos en `outputs/p00`.

Captura sintética de host durante 10 segundos: 908 cuadros decodificados, 904 identificadores únicos, 4 repetidos, 0 barcodes inválidos; 90,23 cuadros distintos/s. No representa FPS presentados en el teléfono ni latencia extremo a extremo. Memoria máxima del laboratorio: 761,1 MB. Evidencia en `outputs/p00/hfr-reference`.

Los escenarios de política siguen reproduciendo los problemas auditados (incluidos RTT estable y buffer fijo que llevan a 350 kbps). Esto es una referencia anterior al arreglo, no una mejora de rendimiento ya entregada.

Fingerprint del checkout y origen: `6171551c95c6c2fe265aaf80c66eeba6657799a7`. IPA estable: `e08438daeafaecc3eeddd87e38c6004b670a3d9c`. La copia inicial de dependencias por symlink alteraba las rutas del fingerprint; se sustituyó por una copia local y se verificó igualdad con el origen. Sigue pendiente explicar la diferencia histórica con la IPA o generar/instalar una nueva pareja compatible. No publicar OTA basándose en igualdad supuesta. No se cambió código móvil ni dependencias declaradas.

Recursos: Go, Node, Python, GStreamer y VA disponibles y probados; IPA estable preservada, firma/instalación actual sin revalidar; Xcode ausente en Linux; Android SDK/JDK no disponibles en PATH; dispositivo físico y credenciales de firma sin comprobar.

## Reanudación exacta

1. Consultar este estado y el plan maestro; trabajar en este checkout y conservar el origen estable.
2. Ejecutar P01 para corregir política adaptativa, usando `rate_baseline.py --compare` y los criterios del maestro. Cambiar las pruebas que caracterizan fallos por regresiones corregidas; conservar fixture/reporte anterior para A/B. El test de equivalencia con la clase original corresponde únicamente a la extracción P00 y debe retirarse al cambiar intencionalmente la política.
3. P01A sigue como bloque independiente prioritario para Unicode, pegado, dictado, atajos y adjuntos. No están corregidos por P00.
4. Antes de promocionar cambios nativos, resolver P00.6 con build compatible y prueba física de arranque/reconexión. No marcarla aprobada por pruebas de host.
5. Al terminar cada bloque: pruebas pertinentes, commit, actualizar este archivo y continuidad externa; entregar un checkpoint para revisar cuota.

## Rollback

Durante P00 no cambió el servicio activo: basta volver al checkout original. Para una futura promoción, verificar primero todos los SHA256 del manifiesto, restaurar paquete y unidades respaldadas a sus rutas registradas, recargar systemd y reiniciar solo los servicios PhonePad afectados, seguido de reconexión física. No ejecutar este rollback ahora. El bundle permite recuperar el código original incluso si desaparece el checkout de referencia.
