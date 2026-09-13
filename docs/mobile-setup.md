> Estado actual: ver [verificación del 12/09](verificacion-2026-09-12.md) y [app nativa](../mobile/README.md). Este documento conserva detalles y estados históricos.

# Phonepad: instalación y uso de la app

> Decisión actual: Lucas retoma la app nativa propia con Liquid Glass y acepta la renovación gratuita cada siete días. Se continúa con la IPA personal ya compilada, firma local mediante iloader e instalación por USB. Las alternativas investigadas no se implementaron. La app aún no está instalada.

## Experiencia para Lucas

La app está preparada para la laptop y el iPhone que ya tienen Tailscale y autorización. El servidor verifica la identidad del dispositivo en cada conexión. La autorización no depende de Safari, sus cookies o su almacenamiento.

**Primera instalación personal, presupuesto $0:** la IPA para iPhone ya se compiló en Expo Free. Falta firmarla/instalarla por USB desde Linux con iloader y una cuenta Apple gratuita. La cuenta Expo `lucas0expo` autorizó la CLI y el proyecto está vinculado. La versión 1.0.0 (build 2), `5397c51e-d6c1-4103-a811-f150d0eafbcd`, está descargada y verificada e incluye EAS Update. Reemplaza la primera IPA, que todavía no tenía actualizaciones inalámbricas. La firma personal vence a los siete días: requiere renovación y no ofrece la permanencia de una app de App Store.

**Cada día:** abrir Phonepad → conexión automática → controlar. Al volver de otra app, recupera el control y, si estaba abierta, la preview. Si hay una actualización compatible ya descargada, la aplica antes de reconectar y vuelve al touchpad inicial. Si la laptop no responde, espera y reintenta; no pide un QR por una caída de red. Una sesión que otro cliente tomó se recupera con el botón de reconectar para no pelear entre clientes.

Para construir usamos una cuenta Expo Free. Para la instalación personal se necesita autorizar la laptop por USB, activar Developer Mode en el iPhone y firmar localmente con Apple. En el uso diario no se necesita Metro, una terminal, la cuenta Expo ni otro login de Phonepad: el perfil `personal` genera Release con el código incluido. No se instala una CA propia ni se usan certificados compartidos. Tailscale sí debe estar conectado, y la laptop encendida y disponible. La app no puede encender una laptop suspendida ni mantener ejecución ilimitada en segundo plano de iOS.

Para otro teléfono, la primera autorización del dispositivo sigue siendo necesaria. La app actual es personal: conoce esta laptop. Un instalador general, selección de computadoras y vinculación inicial para nuevos usuarios no están implementados.

## Cómo se construye

- Expo SDK 57 / React Native 0.86 / Hermes. Sin WebView.
- Liquid Glass nativo con comprobación de disponibilidad y SF Symbols.
- Gestos reconocidos en el hilo de UI. Zoom por Reanimated; comandos pequeños al canal de control, con movimiento agrupado y descarte de datos viejos bajo congestión. No hay renders React por movimiento.
- Teclado del sistema, incluido su dictado. InputAccessoryView para los atajos; una fila en horizontal amplio y dos en vertical, sin scroll. Keyboard Controller adapta el área de preview al espacio libre.
- Libwebrtc nativo y RTCView para el video: los frames no pasan por JavaScript. H264 a resolución física hasta 1920×1080 en el equipo actual, sin renegociar por rotación o zoom. El mayor FPS de la interfaz no implica el mismo FPS del escritorio.
- La app no solicita cámara ni micrófono. Copy/Paste actúan en la laptop y no leen el portapapeles del iPhone.
- HTTPS privado por Tailscale. La app no incluye una contraseña compartida ni ignora errores TLS. El video usa el servidor existente, sin LiveKit Cloud.

## Construcción e instalación personal sin pagar

La ruta elegida separa compilación y firma. EAS usa un Mac remoto; la laptop Linux firma e instala después. No requiere subir la contraseña Apple a Expo ni vincular un repositorio GitHub. `withoutCredentials: true` es una opción oficial de EAS para builds personalizados; no desactiva la verificación de firmas en el iPhone.

1. Inicio de sesión y asociación completados: `@lucas0expo/phonepad`, proyecto `a424819c-da67-44c6-bf43-8a09b2e554a2`. Para configurar otra laptop: `eas login --browser` y `eas init`. Usar el plan Free y su cupo; no contratar upgrades. La cuenta conectada en el teléfono no autoriza automáticamente la CLI.
2. Desde `mobile/`, ejecutar el perfil personal. Limitar explícitamente el archivo enviado a esa carpeta:

   ```sh
   EAS_NO_VCS=1 EAS_PROJECT_ROOT="$PWD" npx eas-cli@23.2.0 build --platform ios --profile personal
   ```

   Este perfil usa un builder `medium` con Xcode 26.6, sin firma Apple ni envío a App Store. `.eas/build/ios-personal.yml` ejecuta validaciones, genera iOS, instala Pods y archiva `iphoneos/arm64` en Release. Incluye el JavaScript/Hermes en el binario. Free tiene cupo y tiempo máximo de build; si se agota, esperar su renovación, no pasar a un plan pago.
3. Descargar `Phonepad-unsigned.ipa`. La validación del archive verifica plataforma iPhone, SDK 26+, ejecutable arm64, bundle incluido, WebRTC nativo, ProMotion, ausencia de permisos propios de cámara/micrófono y configuración OTA real dentro del binario. Un archivo que pasa esos checks aún está **sin firmar y sin probar en el teléfono**.
4. Conectar el iPhone por USB a la laptop, desbloquearlo y autorizar la computadora. En iloader oficial, iniciar sesión con la cuenta Apple gratuita directamente en la aplicación, importar esa IPA y completar la instalación. La contraseña no se comparte en el chat ni con EAS. Confirmar en iOS los pasos de confianza y Developer Mode que correspondan.
5. Abrir Phonepad con Tailscale conectado y verificar el binario real. Conservar la IPA para volver a firmar antes de los siete días. Renovar la firma no exige recompilar si no cambió la app.

iloader 2.3.1 se descargó del release oficial, se verificó el SHA-256 de su DEB y se inició desde la copia extraída localmente. `usbmuxd` está disponible en esta laptop. La instalación, la firma y la compatibilidad real con este iPhone siguen pendientes. La revisión de procedencia, credenciales y permisos está en [iloader-confianza.md](iloader-confianza.md); es una revisión acotada, no una auditoría completa.

No se instala SideStore como requisito de la primera prueba: su actualización usa una VPN local y hay que estudiar su convivencia con Tailscale antes de prometer renovación automática. La opción personal gratuita conserva la limitación de siete días y no es distribución permanente para otros usuarios. Para TestFlight/App Store existe otra ruta con membresía Apple Developer, que queda fuera del presupuesto autorizado. Los perfiles `testflight`/`production` están preparados pero no se ejecutan en esta ruta.

Build actual: https://expo.dev/accounts/lucas0expo/projects/phonepad/builds/5397c51e-d6c1-4103-a811-f150d0eafbcd

Cupo consultado después de ambas compilaciones: Free, 2/15 builds iOS usados, sin addons, costo estimado $0. Sólo se envió el directorio móvil a EAS. No se publicó ni modificó el repositorio GitHub.

## Costos y distribución

- Usar Phonepad y el servidor en la laptop: sin licencia Apple ni pago a Expo.
- Compilar con Expo Free: $0 dentro de sus límites. El builder configurado no utiliza recursos de clase `large`.
- Instalar personalmente con cuenta Apple gratuita: sin membresía paga; renovación de la firma cada siete días y límites de apps/dispositivos de Apple.
- TestFlight/App Store: membresía Apple Developer de USD 99/año o precio local. No es necesaria para la ruta personal elegida y no se contrató.

## Actualizaciones

La IPA actual incluye `expo-updates` y su código de arranque. No necesita Metro ni esperar una descarga para abrir. Los cambios compatibles de JavaScript, interfaz y recursos pueden publicarse por EAS Update, sin cable ni reinstalación. Las correcciones del servidor se instalan en la laptop. Los cambios de dependencias nativas o SDK requieren otra IPA y firma/instalación; ninguna OTA renueva la firma gratuita de siete días.

La app consulta al entrar en primer plano, como máximo una vez cada cinco minutos; el botón de reconectar también puede consultar. No inicia una descarga con la preview abierta. Una descarga ya iniciada puede terminar después de abrirla, pero nunca recarga por terminar la descarga. Aplica lo descargado al volver de un paso real por segundo plano, antes de aceptar comandos. Un aviso de permisos o notificación (`inactive`) no dispara la aplicación. Sin red conserva la versión instalada. No se garantiza recibir cambios mientras iOS mantiene la app suspendida.

Canal `personal`, runtime por `fingerprint`, arranque sin espera y recuperación de Expo habilitada. El fingerprint del build 2 coincide con el update publicado: `1474787615b80178d88e3c34f427ccb39a1449fe`. El canal entregó HTTP 200 y los 24 recursos pasaron SHA-256; un runtime incompatible recibió HTTP 204 sin actualización. Esto verifica la distribución y compatibilidad, no la aplicación de una OTA en un iPhone instalado.

Después de validar una corrección, desde `mobile/` el desarrollador publica:

```sh
npm run typecheck
npm test
EAS_NO_VCS=1 EAS_PROJECT_ROOT="$PWD" npx eas-cli@23.2.0 update \
  --channel personal --platform ios --environment development \
  --message "Descripción de la corrección" --non-interactive
```

Editar código o conectar GitHub no publica una actualización automáticamente. La publicación debe verificarse contra el runtime de la IPA instalada; si cambió la parte nativa, crear otra IPA. No forzar un fingerprint antiguo para evitar recompilar. La distribución usa HTTPS y la cuenta Expo propietaria; no se configuró la función adicional paga de firma de código de EAS Update ni se contrató un plan pago.

## Verificación realizada — 2026-09-09

- TypeScript estricto sin errores.
- 25 pruebas automatizadas: 17 de protocolo, autorización y recuperación, más 8 de actualizaciones (sesión activa, segundo plano, preview, sin red, concurrencia, rollback, error al recargar y limpieza de efectos).
- 8 pruebas de empaquetado; incluyen rechazo de canal OTA incorrecto y fingerprint vacío.
- Las pruebas de red/receiver usan transportes y libwebrtc simulados: verifican nuestra lógica de recuperación, no la implementación nativa ni la red del iPhone.
- Prebuild genera el proyecto iOS sin permisos de cámara/micrófono y con `CADisableMinimumFrameDurationOnPhone` habilitado.
- La comprobación de dependencias y el bundle se registran en `native-app.md`.

Xcode 26.6 compiló y enlazó correctamente la app, incluidos los módulos nativos. La IPA actual se verificó tras descargarla: iPhoneOS 26.5 / arm64, 15.838.168 bytes, bundle incluido de 3.868.581 bytes, WebRTC y Expo Updates presentes y sin permisos propios de cámara/micrófono. SHA-256 `cc2a3fba8a25fec49131483b850c1eb88f45906b1ff53e498a34074ecf671d37`. Las 25 pruebas JavaScript y las 8 de empaquetado también pasaron en EAS. Falta firmar e instalar el binario. Antes de llamarla lista, validar en iPhone los gestos, dictado/borrado y atajos, apertura/cierre/rotación con teclado, Liquid Glass y accesibilidad, reconexión Wi-Fi ↔ celular, aplicación/recuperación de una OTA, y FPS/latencia/bitrate/consumo reales. La app nativa elimina Safari; no demuestra por sí sola que desaparezcan las ondas o el retraso originado en la captura, el encoder o la red.

## Fuentes oficiales

- https://docs.expo.dev/versions/v57.0.0/
- https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/
- https://docs.expo.dev/versions/v57.0.0/sdk/keyboard-controller/
- https://kirillzyusko.github.io/react-native-keyboard-controller/docs/1.21.0/api/components/keyboard-avoiding-view
- https://docs.expo.dev/eas/json/
- https://docs.expo.dev/custom-builds/get-started/
- https://expo.dev/pricing
- https://github.com/nab138/iloader
- https://developer.apple.com/help/account/basics/about-your-developer-account
- https://developer.apple.com/help/account/membership/program-enrollment/
- https://docs.sidestore.io/docs/installation/prerequisites
- https://docs.expo.dev/submit/testflight/
- https://developer.apple.com/testflight/
- https://docs.expo.dev/versions/v57.0.0/sdk/updates/
- https://docs.expo.dev/eas-update/runtime-versions/
- https://docs.expo.dev/technical-specs/expo-updates-1/
- https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/gesture-composition/
