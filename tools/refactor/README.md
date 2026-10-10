# Laboratorio P00

Ejecutar desde la raíz del repositorio. No modificar red ni servicios personales. `outputs/` no se versiona; preservar esa carpeta junto al checkout. La bitácora está en `docs/phonepad-refactor/estado.md`.

## Referencia y comparación en un comando

Con la captura y los perfiles ya verificados:

```sh
python3 tools/refactor/collect.py --baseline outputs/p00/baseline/manifest.json --network outputs/p00/network-lab-v2.json --capture outputs/p00/hfr-reference/result.json --out outputs/p00/collected
```

Un directorio de salida nuevo impide sobreescribir evidencia. El recolector verifica las condiciones mínimas de aislamiento/decodificación, incorpora hashes de entradas y vuelve a ejecutar todos los escenarios de política. No vuelve a medir red ni captura. A/B de una política nueva:

```sh
python3 tools/refactor/rate_baseline.py --out outputs/p01/rate.json --compare outputs/p00/rate-baseline.json
```

Exige el mismo hash de fixture. Mínimo/final de bitrate son diagnósticos, no un criterio suficiente de calidad o congestión. Conservar targets por muestra para estudiar recuperación. Los intervalos del fixture son muestras, no segundos.

## Repetir pruebas reales de host

`python3 tools/refactor/network_lab.py --out SALIDA_NUEVA.json` crea namespaces privados y veth; usa `ip`, `tc`, `nsenter`, `unshare` y soporte de user namespaces. Si el sandbox impide esos recursos, requiere ejecución fuera del sandbox. Nunca sustituir por netem en una interfaz personal. Ocho perfiles: limpia, pérdida, jitter, capacidad, recuperación, salto RTT, UDP bloqueado y cambio de ruta. Su tráfico UDP echo comprueba funcionamiento; no mide capacidad máxima ni la sesión PhonePad.

Para captura, establecer `PHONEPAD_LAB_RUNTIME` al runtime local de PhonePad y ejecutar `tools/hfr/isolated.py` dentro de una unidad temporal systemd de usuario con `MemoryMax=1000M`, `RuntimeMaxSec=70`, `KillMode=control-group` y `PHONEPAD_LAB_SECONDS=10`. El laboratorio informa su directorio temporal. Después decodificar con `PHONEPAD_HFR_ROOT=DIRECTORIO PHONEPAD_LAB_DECODE=1 python3 tools/hfr/runtime.py tools/hfr/verify_frames.py DIRECTORIO/cycle-0`, manteniendo la variable del runtime. Copiar result.json, motion.h264 y resources.json a evidencia persistente. `PHONEPAD_LAB_SCENE_PROFILE=quality` incluye pausas reales; el perfil predeterminado motion mide movimiento constante.

Para comparar captura A/B fijar hardware, runtime/plugins, escena y perfil, resolución, duración, límites de recursos y carga concurrente. No mezclar con FPS del receptor. Medir receiver FPS, latencia input-to-photon, consumo y calidad bajo WebRTC/dispositivo físico sigue pendiente en las fases correspondientes.

`python3 tools/refactor/snapshot.py --help` muestra cómo congelar una referencia limpia, servidor, IPA y unidades específicas sin reiniciarlas. El manifiesto incluye recursos y hashes; no incluir archivos de credenciales.

## Validación de lógica

```sh
python3 -m unittest discover -s tools/hfr -p 'test_*.py'
python3 -m unittest discover -s tests -p 'rate_policy_test.py'
```

Las demás pruebas Python necesitan GI/GstWebRTC y el runtime de video original. Pruebas móviles: `npm test` y `npx tsc --noEmit` en mobile; Go: `go test -race -mod=vendor ./...` y `go vet -mod=vendor ./...` en daemon. El empaquetador `tools/hfr/stage_release.py` incluye el nuevo módulo rate_control; comprobar hashes del release antes de desplegar.
