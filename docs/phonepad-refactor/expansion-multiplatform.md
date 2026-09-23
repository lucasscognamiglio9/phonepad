# PhonePad: equipos y plataformas

Estado al 23 de septiembre de 2026. Este alcance sigue a P00–P06; no cambia sus estados ni declara compatibilidad física que no se haya probado.

## Resultado buscado

Una app en iPhone o Android controla cualquiera de los equipos guardados: Ubuntu, macOS o Windows. Cada computadora ejecuta su propio servidor y conserva sus permisos e identidad. El teléfono muestra solo nombres de equipos, no detalles técnicos durante el uso normal.

## Entrega 1: selector de equipos

- Al tocar el icono de monitor desde la pantalla principal, abrir un menú Liquid Glass con los nombres guardados y una última fila, **Agregar nuevo**. Reutilizar el estilo y las medidas del menú **+**.
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
- Mantener firma gratuita del iPhone con su propia cuenta Apple. Su Mac puede firmar e instalar la IPA compatible; la firma personal vence a los siete días. Crear una skill breve y comprobada para instalación inicial, renovación de la misma IPA, actualización OTA compatible y diagnóstico de versión antigua. La skill no debe contener credenciales.
- Entregar builds identificados y rollback para cada plataforma. Una OTA de JavaScript no renueva la firma ni sustituye una IPA cuando cambian componentes nativos.

**Cierre:** una sesión física completa Mac–iPhone, Windows–iPhone y al menos un recorrido Android; instaladores y renovación repetibles por otra persona. Hasta entonces, la única combinación validada es Ubuntu–iPhone.
