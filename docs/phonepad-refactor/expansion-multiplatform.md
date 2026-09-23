# PhonePad: equipos y plataformas

Estado al 23 de septiembre de 2026. Este alcance sigue a P00–P06; no cambia sus estados ni declara compatibilidad física que no se haya probado.

## Resultado buscado

Una app en iPhone o Android controla cualquiera de los equipos guardados: Ubuntu, macOS o Windows. Cada computadora ejecuta su propio servidor y conserva sus permisos e identidad. El teléfono muestra solo nombres de equipos, no detalles técnicos durante el uso normal.

## Entrega 1: selector de equipos

- Al tocar el icono de monitor desde la pantalla principal, abrir un menú Liquid Glass como el menú **+**. Cada fila muestra un punto de estado y el nombre guardado, por ejemplo Windows, Mac o Ubuntu; la última fila dice **Agregar nuevo**. Son ejemplos, no nombres ni cantidad fijos. El equipo activo debe distinguirse sin recargar la interfaz.
- El punto verde indica una conexión confirmada con ese equipo. Si no se ha comprobado su disponibilidad, usar un punto neutro; si falla, indicar que está desconectado. No mostrar a todos los equipos como conectados solo por estar guardados.
- Tocar el equipo actual abre su preview. Tocar otro cambia la sesión completa —video, input, archivos y portapapeles— y abre su preview. El botón de ocultar pantalla dentro de la preview sigue cerrándola.
- **Agregar nuevo** pide solo nombre y dirección HTTPS de Tailscale, por ejemplo `https://equipo.tailnet.ts.net`. El servidor actual acepta el origen raíz, sin ruta, consulta ni credenciales. Validar y guardar con el almacenamiento existente; pedir autorización al servidor cuando corresponda.
- Al cambiar de equipo, cerrar los recursos del anterior sin reenviar acciones. Conservar borradores y transferencias pendientes con revisión explícita antes de cambiar; mostrar un error breve si el nuevo equipo no está disponible. Adaptar posición, scroll, safe areas y accesibilidad a vertical, horizontal y tablets.

**Aceptación:** alternar entre dos equipos sin mezclar sesiones, recuperar el anterior al fallar la conexión y comprobar que preview, teclado, archivos y portapapeles apuntan al seleccionado.

## Entrega 2: servidores macOS y Windows

Mantener el servidor, protocolo y pruebas comunes. Añadir adaptadores de captura, codificación, cursor, input, portapapeles y permisos propios de cada sistema. Ubuntu conserva su ruta actual.

- **macOS Apple Silicon:** captura con ScreenCaptureKit; control mediante APIs públicas de macOS y permiso de Accesibilidad. Instalador que guíe los permisos de grabación de pantalla y control.
- **Windows:** captura con Windows Graphics Capture; mouse y teclado con SendInput. Instalador con arranque, actualización y desinstalación reversibles.
- Ambos exponen el mismo servicio local por HTTPS privado de Tailscale Serve. Cada instalación mantiene su identidad y emparejamiento independientes. Las funciones no disponibles se anuncian como capacidades; la app no las simula.

**Aceptación por sistema:** instalación limpia, selección y permisos, video y cursor inicial, sensibilidad y gestos equivalentes cuando la API lo permita, Unicode y atajos, archivos, portapapeles, pausa/reconexión, revocación, actualización y rollback. Probar en las computadoras reales antes de declarar paridad. No exigir que macOS reproduzca eventos multitáctiles internos de `uinput` si sus APIs públicas no lo permiten; documentar y validar la alternativa de gesto.

## Entrega 3: Android

Usar el cliente React Native y el protocolo existentes. Ajustar los controles nativos y permisos Android donde difieran de iOS; compilar un APK instalable sin cuenta de tienda. Verificar selección de equipos, teclado, gestos, video, archivos, portapapeles, rotación, ventanas y reconexión en un teléfono Android real. El perfil APK existente no equivale a esa aceptación.

## Instalación y mantenimiento con poca fricción

- Para el amigo, distribuir un instalador de Mac y otro de Windows; un solo cliente iPhone muestra ambos equipos. Configurar Tailscale en su Mac, Windows e iPhone y emparejar cada servidor una vez. No compartir claves, sesiones ni la identidad del Ubuntu actual.
- Mantener firma gratuita del iPhone con su propia cuenta Apple. Su Mac puede firmar e instalar la IPA compatible; la firma personal vence a los siete días. Entregar un handoff breve para sus agentes: instalación inicial, renovación de la misma IPA, actualización OTA compatible, diagnóstico de versión antigua y comprobación física. Sin credenciales.
- Entregar builds identificados y rollback para cada plataforma. Una OTA de JavaScript no renueva la firma ni sustituye una IPA cuando cambian componentes nativos.

**Cierre:** una sesión física completa Mac–iPhone, Windows–iPhone y al menos un recorrido Android; instaladores y renovación repetibles por otra persona. Hasta entonces, la única combinación validada es Ubuntu–iPhone.

## Mapa del plan maestro, pendiente de acordar alcance

Este mapa ordena el solapamiento; no marca tareas antiguas como terminadas ni reemplaza todavía el plan maestro.

| Fase original | Relación con este alcance | Decisión pendiente |
| --- | --- | --- |
| P00–P06, incluida P01A | Base Ubuntu–iPhone ya implementada en gran parte; siguen correcciones y aceptación física, como dictado, copia al iPhone y legibilidad del video. | Registrar cada corrección con prueba y confirmación en el teléfono. |
| P07 | Ya hay lista de equipos, origen HTTPS, autenticación y Tailscale. El selector visual y el cambio seguro de sesión siguen pendientes. | Posponer LAN/QR y STUN/TURN públicos mientras Tailscale cubra las conexiones privadas. |
| P08 | Host Ubuntu actual; el plan original amplía compatibilidad Linux. | Mantener GNOME/Ubuntu como referencia y decidir luego si se amplía a otras distribuciones. |
| P09 | Celulares como equipos controlados. No es lo mismo que Android como controlador. | Dejar fuera del alcance actual salvo nueva decisión. |
| P10 | Hosts macOS y Windows sí coinciden. El cliente de escritorio del plan original es otro producto. | Priorizar servidores Mac/Windows y posponer el cliente de escritorio. |
| P11 | Instaladores, onboarding y mantenimiento coinciden parcialmente. | Limitar por ahora a instalación privada y handoff de firma gratuita; tiendas y despliegue público quedan por decidir. |
| P12 | Validación por combinación de dispositivos. | Cerrar solo combinaciones probadas físicamente y conservar rollback. |

## Reutilización antes de implementar

- El cliente ya tiene almacenamiento validado de varios equipos, selección de equipo, componentes `GlassSurface` y un menú **+** que resuelve anclaje, teclado, orientación y accesibilidad. Reutilizar esas piezas y sus medidas; no crear otra lista persistente ni dibujar un vidrio falso.
- Usar Expo SDK 58 como objetivo para la siguiente IPA. Al 23/09/2026 sigue en beta, incluye React Native 0.88 RC y Expo todavía no ofrece las imágenes EAS con Xcode 27. Mantener SDK 57 en la app instalada hasta que una rama aislada pase instalación de dependencias, typecheck, pruebas, export y build iOS/Android, y el iPhone confirme el recorrido completo. La migración nativa exige IPA nueva; no se entrega por OTA.
- El menú debe reutilizar `GlassSurface`, el anclaje del menú **+** y el almacenamiento de equipos. Comparar `@expo/ui` de SDK 58 solo si permite el punto de estado y el mismo comportamiento en iOS/Android sin perder calidad; no agregar una dependencia nativa por el nombre del SDK.
- Tailscale Serve ya resuelve el acceso HTTPS privado entre dispositivos de la misma red Tailscale. Conservar la autenticación y autorización propias de PhonePad; no construir señalización pública solo para agregar equipos.
- Mac y Windows deben reutilizar protocolo, servidor y pruebas comunes. Antes de escribir adaptadores de captura/control, comparar una solución existente con el contrato real de PhonePad. No incorporar código ni cambiar de protocolo sin una prueba de compatibilidad, rendimiento, licencia y rollback.

## Migración nativa sin parches frágiles

El parche actual `mobile/plugins/video-renderer.cjs` modifica el archivo `RTCVideoViewManager.m` de `@livekit/react-native-webrtc` durante prebuild. Ajusta frecuencia de presentación y tamaño del drawable Metal. Expo 58 no garantiza que ese problema desaparezca porque el archivo pertenece a WebRTC, no a Expo.

Antes de quitarlo, medir con el WebRTC actualizado si sigue existiendo el defecto. Si ya está corregido, borrar el parche y sus pruebas específicas. Si persiste, preferir una corrección en upstream o una API pública de configuración; mantener una integración nativa propia solo si se puede versionar y probar sin modificar `node_modules`. Exigir la misma nitidez, fluidez y estabilidad en iPhone real antes de adoptar el reemplazo. La rama SDK 57 y su IPA quedan disponibles para rollback.
