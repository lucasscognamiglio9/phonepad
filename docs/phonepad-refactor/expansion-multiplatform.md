# PhonePad: equipos y plataformas

Estado al 24 de septiembre de 2026. No tenemos acceso a una Mac ni a Windows para pruebas presenciales. El plan separa código verificable en CI de aceptación en los equipos de destino.

## Resultado y dispositivos de prueba

Una sola app en el teléfono se conecta al servidor de cada computadora. El menú del monitor guarda sus nombres y direcciones privadas. Al elegir un equipo cambian juntos video, cursor, teclado, archivos y portapapeles. Cada servidor conserva su propia autorización y permisos.

| Combinación | Uso en el plan | Estado |
| --- | --- | --- |
| Ubuntu + tu iPhone | Referencia y comparación | Funciona; siguen pruebas de calidad bajo pérdida y detalles de entrada. |
| Mac M1 + iPhone | Entrega macOS | Servidor y paquete compilan; pruebas compartidas pasan en runner Apple Silicon. Captura y control físicos pendientes. |
| Windows + iPhone | Entrega Windows | Servidor y paquete compilan; pruebas compartidas pasan en runner Windows. Captura y control físicos pendientes. |
| Mac/Windows + iPhone de tu amigo | Comprobar que otra persona puede instalar y mantener la app | Primera aceptación real de Mac y Windows al instalar; no requiere prestarnos los equipos. |

Tu iPhone serviría para probar cualquier host disponible, pero ahora no tenemos Mac ni Windows accesibles. No dependeremos de pedirle prestados los equipos a tu amigo.

## Trabajo en orden

### 1. Fijar el contrato común

Mantener el protocolo, autenticación, estados de sesión y pruebas que ya usa Ubuntu. Separar formalmente las funciones dependientes del sistema: captura y codificación, cursor, entrada, portapapeles, permisos e instalación. Revisar qué implementaciones pueden reutilizarse antes de escribir adaptadores. El cliente debe mostrar las capacidades reales del host; no debe fingir funciones ausentes.

**Salida:** contrato y pruebas comunes ejecutables sin depender de `uinput`, GNOME ni PipeWire. Ubuntu sigue funcionando igual.

### 2. Construir el servidor Mac

Construir el servidor Mac con captura y control del sistema, permisos guiados, arranque y desinstalación. [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) es la API de Apple para captura. Elegir el resto de los adaptadores por contrato y documentación oficial; confirmar su comportamiento durante la instalación real. Exponer el servidor por HTTPS privado con [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

**Candidato disponible:** build y pruebas automatizadas macOS en un runner Apple Silicon. Captura, permisos y control reales quedan sin confirmar hasta la instalación. La captura usa el permiso y codificador WebRTC del navegador local; no se añadió un capturador nativo propio.

### 3. Preparar el cambio de equipo

El menú existente debe cambiar la sesión completa sin repetir acciones ni perder contenido pendiente. Verificar el contrato y estados con pruebas automatizadas; el cambio real entre hosts se acepta al disponer de ambos.

### 4. Construir el servidor Windows

Reutilizar el contrato común. Evaluar [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) para video y las APIs públicas de entrada de Windows para mouse y teclado; verificar sus límites en la computadora real. Preparar instalador, inicio, actualización y desinstalación. Preparar su conexión privada por Tailscale.

**Candidato disponible:** build y pruebas automatizadas Windows, paquete descargable y capacidades declaradas. El video, la entrada y el cambio entre equipos siguen pendientes de instalación real. La captura usa el permiso y codificador WebRTC del navegador local.

### 5. Entregarlo a tu amigo

Después de pasar los builds y pruebas por plataforma, dar a tu amigo los instaladores y un handoff breve para sus agentes: configurar Tailscale, emparejar, instalar la app con su cuenta Apple, renovar la firma gratuita de siete días, aplicar OTA compatible y reconocer una versión antigua. Su instalación es la primera prueba real de Mac y Windows: registrar video, input, archivos, portapapeles, reconexión y cambio de equipo. Corregir cualquier fallo antes de declarar compatibilidad. No compartir tus claves, sesiones ni identidad de Ubuntu.

## Reglas de ejecución

- Cada etapa conserva un build anterior instalable y un modo de volver atrás. Una prueba de compilación no cierra una combinación de dispositivos.
- Tailscale Serve da acceso HTTPS dentro de la tailnet; Mac y Windows autorizan la cuenta Tailscale configurada en cada host, y PhonePad mantiene sus permisos de sesión. Ubuntu conserva su autorización por nodo. No hace falta red pública ni QR para Mac y Windows.
- Conservar la investigación de calidad de transmisión como trabajo transversal. La pérdida de paquetes observada en septiembre volvió el texto ilegible; las correcciones de recuperación están publicadas, pero falta medir y confirmar el resultado bajo pérdida real.

## Relación con el plan maestro

P00–P06 siguen como base Ubuntu–iPhone con sus criterios físicos pendientes. Este plan toma el selector privado de P07, los hosts Mac y Windows de P10, la instalación privada de P11 y la matriz de aceptación de P12. La ampliación a otras distribuciones Linux de P08, controlar teléfonos de P09, el cliente de escritorio, las tiendas y el acceso público quedan fuera de esta entrega. Así evitamos implementar dos veces el mismo selector o convertir esta expansión en otra aplicación.

## Cuándo termina esta tarea

El código, paquetes de host y pruebas automatizadas están listos. Eso significa **candidato listo para instalar**, no compatibilidad confirmada. La tarea termina solo cuando tu amigo instala ambos servidores, usa PhonePad desde un iPhone, alterna entre Mac y Windows, y confirma video legible, cursor, mouse, teclado y dictado, archivos, portapapeles, permisos y reconexión. Debe poder repetir la instalación y recuperar una versión anterior.

No necesitamos que preste sus computadoras. Sí necesitaremos su participación al instalar y probar la primera versión, o resultados de los agentes que ejecute allí. Sin esa observación no puedo afirmar honestamente que ScreenCaptureKit, permisos e input funcionan en sus equipos. Android queda fuera de esta tarea.
