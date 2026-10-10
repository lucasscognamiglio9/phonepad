# Componentes de terceros

La licencia MIT de la raíz cubre el código propio de PhonePad. Los componentes externos conservan sus licencias.

- La app partió de una plantilla de Expo. Su aviso original permanece en [mobile/LICENSE](mobile/LICENSE).
- Los módulos Go incluidos conservan sus avisos dentro de `daemon/vendor/`. Las versiones se registran en `daemon/go.mod` y `daemon/vendor/modules.txt`.
- Las dependencias del cliente se fijan en `mobile/package-lock.json`. Sus paquetes incluyen los avisos correspondientes al instalar con `npm ci`.
- Archivo Black y Space Mono se distribuyen bajo SIL Open Font License 1.1. Los textos originales están en [Archivo Black](daemon/web/fonts/archivoblack-OFL.txt) y [Space Mono](daemon/web/fonts/spacemono-OFL.txt).
- La transmisión nativa utiliza libwebrtc a través de LiveKit. Al distribuir una app compilada, conservá también los avisos incluidos por esas dependencias.
