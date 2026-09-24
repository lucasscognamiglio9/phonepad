# PhonePad: equipos y plataformas

Estado al 24 de septiembre de 2026. Este plan organiza la expansión; no declara compatibles equipos que todavía no se probaron.

## Resultado y dispositivos de prueba

Una sola app en el teléfono se conecta al servidor de cada computadora. El menú del monitor guarda sus nombres y direcciones privadas. Al elegir un equipo cambian juntos video, cursor, teclado, archivos y portapapeles. Cada servidor conserva su propio emparejamiento y permisos.

| Combinación | Uso en el plan | Estado |
| --- | --- | --- |
| Ubuntu + tu iPhone | Referencia y comparación | Funciona; siguen pruebas de calidad bajo pérdida y detalles de entrada. |
| Mac M1 + tu iPhone | Desarrollo y aceptación de macOS | Pendiente de servidor Mac y acceso a esa computadora. |
| Windows + tu iPhone | Desarrollo y aceptación de Windows | Pendiente de servidor Windows y acceso a esa computadora. |
| Android + Ubuntu/Mac/Windows | Aceptación del cliente Android | Pendiente de APK y teléfono Android real. |
| Mac/Windows + iPhone de tu amigo | Comprobar que otra persona puede instalar y mantener la app | Paso final de distribución. No hace falta para validar compatibilidad con Mac o Windows. |

Tu iPhone basta para probar Mac y Windows. El de tu amigo interviene solo cuando comprobemos la instalación independiente y la renovación de su firma gratuita.

## Trabajo en orden

### 1. Fijar el contrato común

Mantener el protocolo, autenticación, estados de sesión y pruebas que ya usa Ubuntu. Separar formalmente las funciones dependientes del sistema: captura y codificación, cursor, entrada, portapapeles, permisos e instalación. Revisar qué implementaciones pueden reutilizarse antes de escribir adaptadores. El cliente debe mostrar las capacidades reales del host; no debe fingir funciones ausentes.

**Salida:** contrato y pruebas comunes ejecutables sin depender de `uinput`, GNOME ni PipeWire. Ubuntu sigue funcionando igual.

### 2. Hacer funcionar Mac con tu iPhone

Construir el servidor Mac con captura y control del sistema, permisos guiados, arranque y desinstalación. [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) es la API de Apple para captura. Elegir el resto de los adaptadores tras probarlos en esa Mac, no por analogía con Linux. Exponer el servidor por HTTPS privado con [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) y emparejarlo con tu iPhone.

**Aceptación:** desde tu iPhone, video legible, cursor, mouse, teclado, texto dictado, archivos, portapapeles, pausa y reconexión. Instalar desde cero y repetir la prueba después de reiniciar la Mac.

### 3. Probar el cambio Ubuntu ↔ Mac

Guardar ambos en el menú existente. Cambiar de equipo debe cerrar la sesión anterior sin repetir acciones ni perder contenido pendiente. Comprobar que el indicador verde corresponde solo a la sesión conectada y que una Mac apagada no rompe la sesión Ubuntu. Si este recorrido falla, corregir el selector antes de añadir otro host.

### 4. Hacer funcionar Windows con tu iPhone

Reutilizar el contrato común. Evaluar [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) para video y las APIs públicas de entrada de Windows para mouse y teclado; verificar sus límites en la computadora real. Preparar instalador, inicio, actualización y desinstalación. Emparejarlo por Tailscale con tu iPhone.

**Aceptación:** repetir el recorrido de Mac y cambiar entre Ubuntu, Mac y Windows sin mezclar sesiones. Si una función no tiene equivalente, anunciarla como no disponible y acordar una alternativa comprobada.

### 5. Entregarlo a tu amigo

Después de validar las tres computadoras con tu iPhone, dar a tu amigo los instaladores y un handoff breve para sus agentes: configurar Tailscale, emparejar, instalar la app con su cuenta Apple, renovar la firma gratuita de siete días, aplicar OTA compatible y reconocer una versión antigua. Probar que puede repetir los pasos con su iPhone. No compartir tus claves, sesiones ni identidad de Ubuntu.

### 6. Añadir Android como controlador

Reutilizar el cliente y protocolo existentes. Compilar un APK, resolver diferencias nativas de permisos y controles, y recorrer selección de equipos, video, teclado, gestos, archivos, portapapeles, rotación y reconexión en un Android real. El perfil de build actual no demuestra compatibilidad física.

## Reglas de ejecución

- Cada etapa conserva un build anterior instalable y un modo de volver atrás. Una prueba de compilación no cierra una combinación de dispositivos.
- Tailscale Serve da acceso HTTPS dentro de la tailnet; PhonePad mantiene su propio emparejamiento y permisos. No hace falta red pública, QR ni señalización nueva para este alcance.
- La app actual usa Expo SDK 57. Evaluar SDK 58 en una rama separada y migrar solo cuando el build nativo y los recorridos de iPhone y Android pasen. Una OTA no sustituye la IPA al cambiar código nativo.
- Conservar la investigación de calidad de transmisión como trabajo transversal. La pérdida de paquetes observada en septiembre volvió el texto ilegible; las correcciones de recuperación están publicadas, pero falta medir y confirmar el resultado bajo pérdida real.

## Relación con el plan maestro

P00–P06 siguen como base Ubuntu–iPhone con sus criterios físicos pendientes. Este plan toma el selector privado de P07, los hosts Mac y Windows de P10, la instalación privada de P11 y la matriz de aceptación de P12. La ampliación a otras distribuciones Linux de P08, controlar teléfonos de P09, el cliente de escritorio, las tiendas y el acceso público quedan fuera de esta entrega. Así evitamos implementar dos veces el mismo selector o convertir esta expansión en otra aplicación.
