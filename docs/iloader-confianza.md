# Revisión acotada de iloader — 2026-09-09

Lucas pidió explicar la confianza, los permisos y el manejo de su cuenta antes de continuar con la instalación. Esta revisión no equivale a una auditoría completa del programa, sus dependencias o su cadena de compilación.

## Procedencia comprobada

La copia descargada corresponde a `nab138/iloader`, versión `v2.3.1`, publicada el 2026-08-01. El SHA-256 local del DEB coincide con el `digest` del recurso `iloader-linux-amd64.deb` de la API oficial de GitHub:

`ec756a1463fe5835082ba7404965fb8588185565030e708fa2e1aec385503a85`

Esto verifica que el archivo coincide con el release del proyecto. No demuestra ausencia de vulnerabilidades ni que la herramienta sea de Apple. Se extrajo como aplicación local; ya se inició iloader. No se alteró el instalador ni se parchearon comprobaciones de iOS.

## Flujo y confianza requerida

Expo compiló el código de Phonepad en una IPA sin firma Apple. iloader recibe las credenciales que el usuario introduce en su interfaz y, según su documentación, autentica con Apple mediante GrandSlam/SRP y 2FA. Obtiene una sesión de desarrollo, registra identificadores, solicita certificados/perfiles, firma la IPA y la transfiere por USB.

Utiliza además un proveedor remoto de anisette para obtener datos que permiten simular un cliente Mac; el proyecto explica que puede aparecer un Mac asociado al inicio de sesión. No se comprobó el comportamiento de red del binario en ejecución ni se auditó íntegramente la biblioteca de autenticación. No afirmar que todos los datos se quedan en la laptop.

El certificado de desarrollo autoriza la app firmada; no es una CA raíz instalada para interceptar HTTPS. La confianza USB es distinta: Apple advierte que una computadora autorizada puede acceder a fotos, contactos y otros contenidos. Esa confianza queda en el iPhone hasta revocarla. Los archivos de emparejamiento y las claves de firma deben tratarse como secretos.

## Almacenamiento: código de la versión exacta

- `account.rs`: `save_credentials` guarda la contraseña mediante el llavero del sistema. No se almacena la contraseña usando ese método cuando la opción está desactivada; todavía se procesa en memoria para iniciar sesión.
- `secure_storage.rs`: los datos de sideloading usan el llavero si está disponible. Si no lo está, o si el usuario lo desactiva, se utiliza almacenamiento en archivos; el propio código advierte que ese fallback es inseguro. No desactivar el llavero como solución a errores.
- Se comprobó únicamente el estado del servicio de secretos de Ubuntu: la colección predeterminada existe y no está bloqueada. No se leyeron contraseñas, tokens ni claves. Eso no comprueba por sí solo qué almacenamiento terminará usando iloader; se debe atender a cualquier aviso al iniciar sesión.

## Recomendación para esta instalación

Usar exclusivamente el release oficial y la IPA de Phonepad verificada. Como reducción de exposición, se recomienda una cuenta Apple gratuita dedicada al desarrollo con 2FA, en lugar de la cuenta principal de iCloud; la documentación del flujo admite una cuenta distinta de la asociada al iPhone. No requiere cambiar la cuenta de iCloud del teléfono. Esta recomendación no significa que se haya creado una cuenta nueva ni que el usuario deba abandonar la que ya eligió.

Las credenciales se introducen directamente en iloader, nunca en el chat. No leer sus logs completos ni exportar archivos de emparejamiento para explicar un problema sin revisar antes el riesgo de exponer secretos.

## Fuentes

- https://github.com/nab138/iloader/releases/tag/v2.3.1
- https://iloader.app/#technical-details
- https://github.com/nab138/iloader/blob/v2.3.1/src-tauri/src/account.rs
- https://github.com/nab138/iloader/blob/v2.3.1/src-tauri/src/secure_storage.rs
- https://support.apple.com/en-us/109054
- https://docs.sidestore.io/docs/installation/install
