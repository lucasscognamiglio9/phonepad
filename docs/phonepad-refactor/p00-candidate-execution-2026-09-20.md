# P00.6: ejecución de candidato nativo — 20/09/2026

## Alcance y entrada

Este bloque implementa únicamente la preparación de P00.6 bajo la autorización vigente para P00–P06. `/root` coordina; los workers Luna xhigh mantienen ownership por paquete y rutas exclusivas. La base de entrada es `refactor/p00-baseline` en HEAD `ef10bf44851f53c52958283caa82464c2873bea1` (`ef10bf4`). El criterio canónico está en [`roadmap-p00-p06.md`](roadmap-p00-p06.md), P00.6, y en `../../outputs/PHONEPAD-PLAN-MAESTRO.md`, P00.6.

Antes de editar se preservaron rama, HEAD y diff. El checkout ya tenía cambios de consolidación en `docs/phonepad-refactor/{estado.md,continuation-2026-09-20.md}` y el roadmap P00–P06 no versionado. P01A y P03 tienen workers activos; este bloque no edita sus rutas ni código de aplicación.

## Cambios aplicados

- `mobile/app.json`: fija `android.package` como `app.phonepad.mobile`, habilita `ios.supportsTablet` para no bloquear P06.1 y elimina el permiso Android explícito de micrófono que duplicaba la política `blockedPermissions` del receptor. La configuración resultante conserva cámara, red, Wake Lock y Bluetooth.
- `mobile/eas.json`: el perfil `personal` declara `android.buildType: "apk"` para que el artefacto interno Android sea instalable cuando exista SDK/JDK y credenciales autorizadas.
- `mobile/scripts/build-ios-personal.sh`: valida Node `>=22.13` antes de prebuild/Xcode, además de las comprobaciones existentes de Xcode 26+, CocoaPods, archive iPhoneOS/arm64, WebRTC, OTA embebida, permisos, ProMotion y fingerprint.
- `docs/phonepad-refactor/estado.md` y `continuation-2026-09-20.md`: actualizan el header a la ejecución P00–P06 autorizada, fijan HEAD `ef10bf4`, enlazan el roadmap/maestro, archivan las instrucciones previas de P07–P12 y registran el preflight real.

No se cambian dependencias npm ni se inventan versiones. `package.json` y `package-lock.json` declaran Expo `~57.0.21`, React Native `0.86.3`, React `19.2.3` y LiveKit WebRTC `144.1.2`; el árbol instalado coincide en las dependencias principales.

## Preflight reproducible

Comandos ejecutados desde `work/phonepad-refactor`:

```text
node --version                         v24.20.0
npm --version                          11.19.0
mobile/node_modules/.bin/expo --version 57.0.23 (CLI)
installed expo package                 57.0.21
mobile/node_modules/.bin/expo config   OK
@expo/fingerprint fingerprint:generate OK
java/javac                             ausentes
ANDROID_HOME/ANDROID_SDK_ROOT          no configurados
adb/sdkmanager                         ausentes
eas                                    ausente
xcodebuild/xcrun/pod                   ausentes en Linux
```

Expo SDK 57 documenta React Native 0.86, Node mínimo 22.13.x, Android compile/target SDK 36 e iOS 16.4+ con Xcode 26.4+. La documentación oficial está en [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) y la configuración de perfiles/APK en [eas.json](https://docs.expo.dev/eas/json/) y [APK de Android](https://docs.expo.dev/build-reference/apk/).

La configuración pública posterior a los cambios se guardó en `outputs/p00/candidate/expo-config-public.json`. Verifica `sdkVersion: 57.0.0`, paquete Android `app.phonepad.mobile`, `ios.supportsTablet: true`, micrófono bloqueado y runtime `policy: fingerprint`.

El fingerprint provisional posterior a los cambios es:

```text
1d8b6f0fa2013ffaeebf8a8cdb26b73a3be62562
```

La diferencia respecto del fingerprint de configuración anterior `6171551c95c6c2fe265aaf80c66eeba6657799a7` está limitada a `app.json` y `eas.json`: paquete Android, soporte de iPad y perfil APK. El detalle está en `outputs/p00/candidate/fingerprint-diff.txt`; los hashes y el comando se conservan en `outputs/p00/candidate/`.

## Vía de build y bloqueo externo

La vía local de iOS es `mobile/scripts/build-ios-personal.sh`. En un Mac autorizado ejecuta Expo prebuild sin instalar dependencias, CocoaPods, archive Release `iphoneos/arm64` sin firmar y `check-ios-app.py`; después la firma personal debe ocurrir en ese equipo. No se puede ejecutar en este Linux porque faltan Xcode 26+, CocoaPods y firma.

La vía EAS está preparada en el perfil `personal`, pero no se lanza: EAS CLI no está instalado y el usuario no autorizó un build cloud de pago. El perfil iOS conserva `withoutCredentials` y archivo unsigned para la ruta personal; el perfil Android pide APK interno, pero todavía requiere un builder autorizado y credenciales de instalación.

El recurso mínimo para continuar P00.6 es acceso autorizado a un Mac con Xcode 26.4+, CocoaPods, Node compatible y firma personal para generar la IPA. Para un APK instalable se necesita además Android SDK/JDK y un dispositivo o builder Android autorizado. Hasta entonces P00.6 queda en **preparación reproducible**, no en candidato instalable ni release.

## Estado y rollback

No se ejecutó prebuild, archive, firma, instalación, arranque, reconexión, OTA, deploy, push ni limpieza. El árbol sigue compartido con otros workers, por lo que el fingerprint definitivo y el manifest de release se regenerarán desde el checkpoint integrado limpio. El rollback documental es revertir `app.json`, `eas.json` y el script al checkpoint de entrada; no se modificaron servicios personales ni credenciales.
