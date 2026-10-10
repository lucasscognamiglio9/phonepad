# Auditoría del código

Revisión del 9 y 10 de octubre de 2026. Abarca el servidor Go, la app móvil, la captura de Linux, los instaladores, las dependencias y los archivos destinados a publicación. PhonePad sigue en pruebas.

## Cambios

- Las páginas locales de emparejamiento y captura comprueban la dirección de origen, `Host` y el origen del navegador. Rechazan solicitudes desde otro sitio y nombres usados para DNS rebinding.
- Los archivos recibidos y las claves TLS usan permisos privados, también al reutilizar directorios. Windows aplica permisos mediante ACL.
- El mínimo de Go es 1.26.9 para incluir los parches de seguridad de la biblioteca estándar.
- La captura exige un directorio de ejecución privado. El token del portal se guarda con permisos 0600 y reemplazo atómico.
- El instalador de Linux copia todos los módulos de captura y concede acceso a `/dev/uinput` mediante el grupo `phonepad`.
- La configuración del código público tiene OTA desactivado y no apunta al proyecto personal de EAS.
- Se retiraron prototipos, sus dependencias y notas de operación privadas. El receptor web generado se reconstruyó desde el código compartido actual.
- Los workflows limitan permisos, fijan las acciones por commit y comprueban secretos y dependencias.

## Limpieza del código

Se retiraron los laboratorios históricos de captura y red, la prueba que dependía de un commit privado ausente y el instalador de swap y servicios de diagnóstico. Los auxiliares vigentes de políticas de video y la prueba entre TypeScript, Go y Python quedaron en `tests/`. CI ejecuta ahora esa prueba con HTTPS y WebSocket locales.

El análisis de referencias y de llamadas en Linux, Mac y Windows detectó constructores y un parser del antiguo control por agentes, dos funciones sin llamadas y una pantalla de ayuda sin uso. Se retiraron. `@expo/ui`, importado por la app, pasó a declararse como dependencia directa con la misma versión fijada. El archivo JavaScript generado se identifica como tal; las pruebas y el código web propio siguen visibles.

## Comprobaciones

Las pruebas locales cubren tipos y comportamiento del cliente, sesiones, autorización, revocación, transferencias, permisos, certificados y contratos de video. Se ejecutaron las pruebas Go con detector de carreras y `go vet`, y se compiló el servidor de Linux. La exportación JavaScript para iOS coincide con su mapa de fuentes.

El repositorio de publicación parte de un historial nuevo, sin notas privadas ni paquetes piloto anteriores. Gitleaks comprueba ese historial sin excepciones. `govulncheck` no encontró llamadas vulnerables en el servidor de Linux con Go 1.26.9. Los avisos de análisis estático se revisaron por ruta y contexto; no se silencian globalmente.

Los workflows vuelven a comprobar el código y compilan en Mac y Windows. Una compilación no confirma permisos, entrada o video en dispositivos reales.

## Dependencias pendientes

La actualización eliminó el aviso crítico y otros avisos corregibles. `npm audit` todavía identifica 20 paquetes afectados por dos avisos altos, sin versión corregida disponible al revisar:

| Dependencia | Aviso y uso |
| --- | --- |
| `braces` 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Agotamiento de pila al procesar patrones anidados. Entra por las herramientas de compilación y Metro. |
| `node-forge` 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Verificación de firmas RSA. Entra por Expo CLI y herramientas de firma. |

No se demostró explotación en PhonePad. Estos avisos siguen abiertos. Usá fuentes de confianza para compilar. `npm start` limita Metro a localhost. Mantenelo fuera de redes públicas y no aceptes certificados o firmas de terceros sin verificar su origen. La política de CI permite únicamente esos dos avisos hasta el 9 de noviembre de 2026; bloquea avisos nuevos, críticos o una excepción vencida.

## Límites

La compilación nativa de iOS se verifica por separado en el workflow `ios-unsigned.yml`. Se comprueban arquitectura arm64, bundle incluido, WebRTC, permisos y ausencia de perfiles personales y configuración OTA anterior. La instalación y la sesión real en el iPhone requieren comprobación en el dispositivo.

Esta revisión no modificó la instalación en uso ni validó una instalación nueva. Mac y Windows continúan como candidatos sin sesión física completa verificada. La captura se detiene desde el sistema o su servicio; no se ofrece revocación independiente del permiso de video.

La publicación incluye el código en pruebas. Los paquetes candidatos requieren firma local en iPhone y pruebas de uso antes de considerarse estables. El repo anterior se conserva como respaldo privado.

La configuración admite procesos locales de confianza y acceso privado mediante Tailscale. Consultá [SECURITY.md](../SECURITY.md) para sus permisos y cómo cortar el acceso.
