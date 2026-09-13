# Investigación: distribución sin pagos ni renovación semanal

**Decisión posterior vigente:** Lucas decidió retomar la app nativa propia y aceptar la renovación gratuita cada siete días. Continuar con la IPA personal ya compilada y con iloader; no migrar a Moonlight, Expo Go ni una web por esta investigación. Liquid Glass nativo y presupuesto $0 siguen siendo requisitos. Firma e instalación pendientes.

La investigación siguiente corresponde al requisito anterior del 2026-09-09: no pagar, no renovar cada siete días y no sustituir esa obligación por una renovación automatizada. Bajo ese requisito se descartaban la IPA personal y SideStore. Se conserva el análisis como referencia, no como decisión actual.

Lucas también rechazó reemplazar Phonepad por Moonlight y reafirmó que Liquid Glass nativo es obligatorio. Mantener la interfaz propia. Las opciones comparadas abajo son investigación, no autorización para cambiar de producto. `GlassSurface` ya usa `expo-glass-effect`; compilación verificada, apariencia en iPhone aún sin comprobar. Expo Go incluye ese módulo en SDK 57, pero no el receptor libwebrtc actual: ofrecerlo como alternativa completa requiere adaptar y verificar la transmisión, y aclarar que se ejecutaría dentro de Expo Go.

## Causa

El vencimiento pertenece al aprovisionamiento de Apple Personal Team. Expo Updates distribuye código compatible, pero no cambia el permiso de ejecución de iOS. Refactorizar React Native, cambiar a Swift o volver a compilar no elimina ese vencimiento.

Fuente: https://developer.apple.com/help/account/basics/about-your-developer-account

## Alternativas verificadas

| Distribución | Pago del usuario | Renovación personal semanal | Qué conserva y qué cambia |
| --- | --- | --- | --- |
| Phonepad IPA con Personal Team | $0 | Sí | Conserva el cliente nativo propio. Descartada por el requisito. |
| SideStore | $0 | Sigue existiendo | Permite renovar en el teléfono; necesita Wi-Fi y LocalDevVPN. Descartada: automatizar una renovación no elimina la obligación. |
| Phonepad dentro de Expo Go | $0 | No usa nuestra firma personal | Incluye GlassEffect, teclado y WebView. No incluye `@livekit/react-native-webrtc`. Requiere adaptar la preview y seguir el SDK soportado por Expo Go. Entorno de pruebas, no equivalente al producto independiente solicitado. |
| Phonepad como web instalada en inicio | $0 | No usa firma de desarrollo | Conserva interfaz propia y WebRTC del navegador. No ofrece los módulos nativos propios ni Liquid Glass nativo; cambia el requisito de app nativa. |
| Moonlight de App Store + Sunshine en la laptop | $0 | No usa firma personal de Lucas | Cliente nativo existente, transmisión y control remoto, soporte Tailscale. Cambia la app y sus controles: no ejecuta la UI React Native de Phonepad. Candidato para resolver uso remoto sin caducidad semanal. |

## Candidato nativo sin caducidad personal: Moonlight + Sunshine

Moonlight se distribuye como app gratuita para iPhone en App Store. Sunshine es un servidor abierto para Linux y soporta codificación VAAPI con GPU Intel. La documentación actual también contempla captura mediante XDG Desktop Portal. La laptop es Ubuntu 26.04.1, con GPU Intel y escritorio GNOME; la compatibilidad documentada no es una prueba de ejecución en este equipo.

Moonlight ofrece modo touchpad, click izquierdo/derecho, scroll y teclado. Sus gestos no son los gestos personalizados de Phonepad: por ejemplo, tres dedos abren el teclado. No se ha verificado Liquid Glass en Moonlight. No se puede cambiar la app de App Store por un fork propio sin volver a resolver la distribución del binario modificado.

El emparejamiento inicial sigue siendo necesario. Tailscale permite acceder desde otras redes; la calidad depende de la ruta de red, captura y encoder. La documentación recomienda conexión directa entre los nodos para streaming. No se prometen FPS, resolución útil o latencia antes de medirlos en la laptop y el iPhone.

Esta ruta elimina la necesidad de firmar una app propia en el teléfono, pero supone adoptar otro cliente. No se instaló Sunshine, no se cambiaron servicios ni se reemplazó Phonepad durante esta investigación.

## Conclusión y límite

Hay alternativas gratuitas sin renovación semanal para el uso remoto. No se encontró una vía que cumpla simultáneamente app iOS independiente propia, todos los módulos nativos actuales, cero pago y cero renovación personal. Usar Moonlight o una web instalada requiere aceptar un cambio concreto de producto; no debe presentarse como si nuestra IPA ya cumpliera esos requisitos.

## Fuentes primarias

- https://docs.sidestore.io/docs/installation/prerequisites
- https://tailscale.com/docs/features/client/ios-vpn-on-demand
- https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/
- https://docs.expo.dev/versions/v57.0.0/sdk/keyboard-controller/
- https://docs.expo.dev/versions/v57.0.0/sdk/webview/
- https://docs.expo.dev/workflow/overview/
- https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/
- https://moonlight-stream.org/
- https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide
- https://docs.lizardbyte.dev/projects/sunshine/latest/

Además, se comprobó `mobile/node_modules/expo/bundledNativeModules.json`: GlassEffect, Keyboard Controller y WebView están incluidos en el SDK 57; el módulo WebRTC actual no está incluido.
