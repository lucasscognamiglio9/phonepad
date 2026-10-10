# Estructura y desarrollo

PhonePad tiene una app móvil y un servidor que se ejecuta en la computadora.

| Directorio del código | Contenido |
| --- | --- |
| `mobile/` | App de iPhone, controles, teclado y vista remota. |
| `daemon/` | Servidor Go, autorización, entrada y transferencia de archivos. |
| `setup/` | Instalación e integración con el escritorio. |
| `setup/preview/` | Captura y transmisión de video en Linux. |

Los contactos del teléfono llegan al servidor. En Linux, libinput interpreta los gestos. El video llega a la app por WebRTC. La app mantiene el borrador de texto hasta que tocás enviar.

## Comprobar el cliente

Con Node.js 22.13 o posterior, ejecutá:

```sh
cd mobile
npm ci
npm run typecheck
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

El servidor requiere Go 1.26.9 o posterior, con los parches de seguridad. Para compilarlo desde una copia del código, ejecutá:

```sh
cd daemon
go build -trimpath -mod=vendor -o phonepad .
go test -mod=vendor -race ./...
go vet -mod=vendor ./...
```

Expo Go no incluye el receptor WebRTC nativo que usa PhonePad. Para probar la app completa hace falta un build propio de iOS y su firma.

Las pruebas de código y compilación no sustituyen la comprobación de instalación, permisos, gestos y video entre dispositivos.

Desde un Mac con Xcode 26.4 o posterior, CocoaPods y las dependencias instaladas, `bash scripts/build-ios-personal.sh` en `mobile/` genera una IPA sin firma personal. El script verifica el archive antes de empaquetarlo. No confirma instalación ni funcionamiento en el iPhone. El workflow manual `.github/workflows/ios-unsigned.yml` ejecuta ese mismo build en un Mac de CI sin credenciales Apple.

Las actualizaciones OTA están desactivadas en la configuración pública. Para usarlas, configurá tu propio proyecto EAS, URL y canal en `mobile/app.json` y generá una app nueva. No reutilices el proyecto ni las credenciales de otra persona.

Las pruebas de video necesitan Python GI, GStreamer y GstWebRTC. En Ubuntu 24.04, las dependencias y el comando están en el job `video-contracts` de `.github/workflows/host-platforms.yml`. Los laboratorios de `tools/` usan un compositor aislado; no forman parte de la instalación normal.

Los contratos de [sesión](phonepad-refactor/session-contract.md), [entrada](phonepad-refactor/input-operation-contract.md) y [archivos](phonepad-refactor/file-transfer-contract.md) describen el protocolo actual. `SPEC.md` y los ADR conservan decisiones históricas de la PWA.

Código propio: [MIT](../LICENSE). [Avisos de terceros](../THIRD_PARTY_NOTICES.md). [Seguridad y límites de la auditoría](auditoria-seguridad.md).
