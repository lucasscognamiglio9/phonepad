# Phonepad para iPhone

App React Native / Expo SDK 57 con Liquid Glass nativo, teclado del sistema,
trackpad multitáctil y transmisión WebRTC en RTCView. La configuración personal
conecta con la laptop autorizada mediante Tailscale.

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

Las correcciones JavaScript compatibles usan EAS Update, canal `personal`, con
runtime por fingerprint. Ocultar la transmisión, tocar Reconectar, esperar la
descarga y volver desde el inicio del iPhone permite aplicar la actualización.
Los cambios nativos requieren una IPA nueva; no se fuerza un runtime incompatible.

## Controles

El video conserva un contenedor de pantalla completa. Solo el composer se mueve
con la altura animada del teclado; al cerrar escribe explícitamente desplazamiento
cero. Girar cierra teclado y controles sin reiniciar la transmisión.

Return del teclado inserta una línea mediante Shift+Enter remoto. El botón Enter
del composer envía un Enter sin modificadores. El texto llega mientras se escribe.
Copiar/Pegar operan sobre el portapapeles de la computadora. Ver
[gestos, atajos y límites](../docs/control-ux.md).

Las pruebas locales verifican comandos, transiciones, empaquetado y recepción de
archivos. La inspección visual de cada versión en el iPhone se registra aparte;
una exportación o descarga correcta no prueba que el dispositivo ya la aplicó.
