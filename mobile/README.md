# Phonepad móvil

App React Native / Expo SDK 57 con Liquid Glass nativo, teclado del sistema,
trackpad multitáctil y transmisión WebRTC en RTCView. Este candidato permite
guardar y elegir equipos por su dirección HTTPS. Video, entrada y archivos
utilizan el equipo seleccionado. Guardar una dirección no concede acceso: sigue
siendo necesaria la autorización del servidor. El recorrido físico de referencia
es iPhone con Ubuntu mediante Tailscale; otras plataformas conservan su validación pendiente.

## Desarrollo y verificación

```sh
npm ci
npm run typecheck
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

Expo Go no incluye libwebrtc. El perfil `personal` genera una IPA Release sin
credenciales de firma Apple en EAS; la firma e instalación se realizan localmente.
La base instalada es build 4, con renderer ProMotion y módulos nativos de cámara,
fotos, archivos y glass. Consultar [distribución](../docs/mobile-setup.md).

La rama de refactor incorpora Expo Crypto y Expo FileSystem. Requiere un nuevo
binario nativo compatible; la IPA estable no acepta este candidato como OTA.
El estado y la evidencia están en [el registro del refactor](../docs/phonepad-refactor/estado.md).

Las correcciones JavaScript compatibles usan EAS Update, canal `personal`, con
runtime por fingerprint. Ocultar la transmisión, tocar Reconectar, esperar la
descarga y volver desde el inicio del iPhone permite aplicar la actualización.
Los cambios nativos requieren una IPA nueva; no se fuerza un runtime incompatible.

## Controles

El video conserva un contenedor de pantalla completa. Solo el composer se mueve
con la altura animada del teclado; al cerrar escribe explícitamente desplazamiento
cero. Girar cierra teclado y controles sin reiniciar la transmisión.

Con un servidor compatible, el texto y las revisiones del dictado quedan en un
borrador local hasta tocar Escribir. El bloque se verifica antes de insertarlo.
Return agrega una línea al borrador; el botón Enter envía una acción aparte y
espera a que el texto pendiente se resuelva. El cliente conserva la ruta anterior
para servidores antiguos y no ofrece envíos literales si no están disponibles.
Copiar/Pegar operan sobre el portapapeles de la computadora. Ver
[gestos, atajos y límites](../docs/control-ux.md).

Fotos y archivos permiten selección múltiple, revisión, pausa y reanudación con
la misma copia local. La publicación del clipboard y Pegar ahora son pasos
explícitos. Equipos vuelve al selector; primero se resuelven los borradores y
adjuntos pendientes. Las actualizaciones también esperan a que termine ese trabajo.

Las pruebas locales verifican comandos, transiciones, empaquetado y recepción de
archivos. La inspección visual de cada versión en el iPhone se registra aparte;
una exportación o descarga correcta no prueba que el dispositivo ya la aplicó.
