# Continuación de PhonePad: 20/09/2026

## Estado de entrada

La reanudación está autorizada en `refactor/p00-baseline`. P01A-04 está implementado en `f7ea113`; P02-02 en `12aa1d7`, P02-01 en `ba45a00` y P02-03 en `e3e7fff`. `e8132e8` completó P02-04/05/07 con media observada, cierre coordinado y compatibilidad. `ce3fe20` incorpora GCC opcional con H264/VA real y 56 pruebas Python; `a14291d` registra la medición inicial de libinput y `c5624bf` añade el candidato cuadrado. `4639ce0` corrige el estado visible de los atajos bloqueados. La cápsula vertical y los iconos están en `4850177`. El trabajo conserva el alcance de 14 fases, 115 tareas y 32 requisitos.

La pareja principal para aceptación será Ubuntu+iPhone. También se pueden coordinar pruebas con un Mac de un amigo y un Android de otro amigo, pero aún no están comprobadas las herramientas de compilación, la firma, los builds, los permisos ni la disponibilidad efectiva de cada equipo. No usar esa posibilidad como evidencia anticipada.

P00.1–P00.5 y P01.1–P01.5 conservan sus resultados. P00.6 y P01.6 siguen parciales. P01A-01–03 tienen implementación y pruebas parciales, no cierre de fase. No hay despliegue, OTA ni reinicio de servicios personales.

## Invariantes de reanudación

- Separar siempre implementación, compilación, laboratorio, aceptación física y distribución.
- Una prueba no ejecutable por falta de teléfono, permiso, toolchain o cuenta queda `espera externa`; no se aprueba por inferencia.
- El trabajo Go/TypeScript/Linux, los fixtures, la instrumentación y las pruebas aisladas pueden avanzar mientras espera un dispositivo.
- Ningún cambio nativo se promociona sin un candidato con fingerprint/runtime registrado, instalación, arranque y reconexión comprobados.
- `input-operation-contract.md` es el contrato de entrada vigente. P01A y P02 deben compartirlo; no crear dos protocolos equivalentes.
- `dispatched`, un ACK del adaptador o una copia en clipboard no demuestran por sí solos que una aplicación arbitraria haya mostrado o pegado el contenido.
- Los 90,23/90,41 cuadros distintos por segundo de laboratorio son resultados de host/decodificación. No acreditan cuadros presentados en el iPhone.

## Orden y dependencias

### 1. P01A-04: implementación verificada

Se completaron la reanudación por archivo/parte y la revisión antes de subir: checksum calculado en móvil, límites negociados y visibles, selección revisable, recuperación de partes sin duplicar las completas y limpieza de staging huérfano tras cancelación o crash. Mantener recibos, deduplicación de lotes completos y rollback existentes. El bloque tiene 138 pruebas móviles, Go race y export iOS; la aceptación física permanece separada.

Después de fijar ese borde, continuar con recibos de acciones/atajos, repetición controlada de flechas y proveedor alternativo para destinos sin `EditableText`. La cobertura física de composición/dictado y los destinos reales de lotes corresponden a la matriz P01A.11 y no se sustituyen por GTK.

### 2. P02 en paralelo controlado

P02.1–P02.7 tienen implementación y verificación de contratos en Linux. Se retiró `COMPUTER`, se extrajeron interfaces portables, se negociaron versión/roles/permisos/capacidades y se introdujeron `sessionEpoch` y `geometryEpoch`. El host puede operar sin input; cierres y cancelaciones tienen límites. El pairing se migra sin reemplazar credenciales ante corrupción.

La compatibilidad mínima pasó ejecutando el TypeScript/Go estables `adab7c77` contra sus equivalentes actuales en ambas direcciones. Una capacidad ausente se rechaza explícitamente y no provoca conversión de texto en scancodes. Las pruebas de migración cubren lectura/escritura legacy/v1 y rollback. La instalación nativa, los pares físicos y sus permisos necesitan la matriz posterior; no se deducen de estas pruebas.

### 3. Calidad y video: P01.6 + P03

El camino H264/VA con GCC y feedback TWCC real está verificado en `p03-02-gcc-integration.md`. El controlador conserva activación explícita. Continuar con la prueba A/B y los criterios de presentación, colas, tráfico, color y temperatura. P03.1–P03.4 pueden implementarse y medirse en el laboratorio Linux con una sola política de bitrate activa. P03.5–P03.8 son comparaciones limitadas por hipótesis y no bloquean las fases de UI, sesión o proveedores si no aportan una mejora repetible.

El cierre de P01.6 exige posteriormente receptor físico: cuadros distintos presentados, detalle de texto, colas, tráfico y latencia bajo la misma escena y perfil. La medición de host no sustituye ese paso.

### 4. P04 y P05

La primera medición real de libinput está en `p04-02-motion-lab.md`. La geometría cuadrada descrita en `p04-01-input-design.md` ya tiene medición inicial; sigue la calibración a velocidad lógica idéntica, transición sin recreación y cursor observable. Implementar cursor, geometría, sensibilidad estable al giro y arbitraje con fixtures. P04.7–P04.9 necesitan recorridos físicos y blancos reales.

P05 puede avanzar sobre esa geometría: Directo/Trackpad, pinch/pan/scroll, ayuda, transferencia explícita y controles. Integrar P01A antes de cerrar teclado, clipboard y adjuntos. El prototipo Liquid Glass, menú, hojas, catálogo de iconos, `KeyboardStickyView` y pantalla activa pueden prepararse antes del binario nativo; su aceptación visual, accesibilidad y rendimiento sobre Metal esperan el candidato.

### 5. P06, P07 y P08

P06.2 y P06.6 pueden prepararse temprano. La instrumentación P06.7 debe identificar primero el build/runtime ejecutado y la causa de la barra desplazada; P06.8, P06.10–P06.14 pueden desarrollarse con fixtures y receptor web, pero P06.9/P06.12 no cierran sin build nativo.

P07 puede implementar identidad, QR, permisos, revocación, prioridad y LAN/loopback con P02. NAT, TURN, IPv4/IPv6, UDP bloqueado y la matriz móvil son aceptación externa. P08 puede avanzar con el proveedor GNOME disponible, portal, clipboard y EIS; KDE, Wayland sin XWayland y permisos residuales quedan como comprobaciones de entorno.

### 6. P09 y P10

P09 requiere Android SDK/JDK o build equivalente, Xcode para iOS y dispositivos con permisos de captura/control. Mantener ReplayKit como ruta iOS compatible y no presentar captura como control global de otras apps. P10 requiere macOS, Windows, sus SDK y permisos propios. Se pueden preparar contratos y módulos aislados, pero no declarar compatibilidad por compilar código inicial.

### 7. P11 y P12

P11 puede preparar bootstrap, documentación, onboarding y el servicio opcional de señalización/TURN. Los paquetes firmados, notarización, Play/App Store, instalación limpia y primera conexión requieren los proveedores y cuentas correspondientes. P12 ejecuta la matriz final, las sesiones prolongadas, integridad P01A, autorización, licencias, migración y rollback.

## Matriz código / build / laboratorio / físico / distribución

| Fase | Código en Linux ahora | Build/candidato | Laboratorio | Aceptación física o toolchain | Distribución |
| --- | --- | --- | --- | --- | --- |
| P00.6 | Preparación ya disponible | Nuevo candidato nativo y fingerprint pendientes | Daemon/servidor comprobados | Ubuntu+iPhone principal; Android/Mac por comprobar | No |
| P01.6 | Política P01.1–P01.5 implementada | Candidato móvil pendiente | A/B host/encoder disponible | Presentación, colas y detalle en receptor | No |
| P01A | P01A-04 implementado; fase abierta | Expo Crypto y FileSystem exigen build compatible | GTK/XWayland privado | iOS/Ubuntu primero; Android después | No |
| P02 | Go/TypeScript/interfaces/fixtures | Puede validarse antes del móvil | Compatibilidad y sesión aisladas | Pares físicos después | No |
| P03 | Instrumentación y camino principal | Runtime servidor seleccionable | HFR, color, colas, comparadores | Energía/temperatura/presentación | No |
| P04–P05 | Geometría, gestos, UI | Cambios nativos requieren candidato | Fixtures/web/GTK | Touch, teclado, Metal, accesibilidad | No |
| P06 | Layout, parches y adaptadores | Android/iOS requieren SDK/build | Fixtures y web | iPhone, Android, tabletas, rotación | No |
| P07–P08 | Protocolos y proveedores Linux | Paquetes posteriores | LAN/loopback/GNOME | NAT/TURN, KDE, Wayland, permisos | No |
| P09–P10 | Contratos o código inicial acotado | Herramientas de cada plataforma | Solo entornos comprobados | Matriz por sentido y permisos | No |
| P11 | Bootstrap, README, onboarding | Firmas, notarización, APK/Play/App Store | Instalación privada cuando haya artefactos | Usuario nuevo y equipos reales | Beta/pública con evidencia |
| P12 | No inicia cierre | Versiones exactas por combinación | Baterías largas y regresiones | Matriz completa por sentido | Release/rollback |

## Criterio de avance por checkpoint

Cada entrega debe registrar:

1. commit de entrada y cambio, estado del árbol y recursos usados;
2. pruebas automatizadas, laboratorio y ubicación de evidencia;
3. build/runtime/fingerprint si hubo código nativo;
4. aceptación física ejecutada, pendiente o no aplicable, con dispositivo y versión;
5. compatibilidad viejo/nuevo, regresiones, rollback y siguiente tarea independiente.

Un bloque Linux puede quedar `verificado` en su dimensión de código/laboratorio sin cerrar la dimensión física. P00.6 es gate para promocionar cambios nativos, no para impedir P02, P03 de instrumentación, P04/P05 con fixtures, P07 sobre loopback ni P08 en GNOME.

## Cierre del plan

El cierre de cada fase requiere evidencia frente a sus criterios existentes y un rollback probado. El cierre de P01A debe incluir contenido observado en los destinos declarados, no solo ACK/recibo. P02 debe demostrar compatibilidad de capacidades entre versiones. P03/P04/P05 deben publicar métricas, variación y decisión de comparadores. P06–P10 deben indicar versiones, permisos, sentidos y entornos realmente probados. P11 debe distinguir artefacto compilado, firmado, beta, revisión de tienda y distribución pública.

P12 cierra únicamente cuando cada requisito tiene implementación y evidencia, o una limitación de plataforma explícita con alternativa evaluada; la referencia estable, los hashes, la configuración y el rollback permanecen recuperables. Las casillas del plan maestro se actualizan solo después de ese recorrido.
