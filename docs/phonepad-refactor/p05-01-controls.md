# P05-01: cápsula vertical e iconos portables

Fecha: 20/09/2026. Base: `9725f09`. Este bloque implementa el prototipo de
P05.10 y el catálogo de iconos de P05.15. No cierra la fase visual ni su
comparación física sobre video.

## Cambios

Los cuatro controles del modo horizontal comparten ahora una
cápsula vertical con una sola `GlassView` de Expo. Cada botón conserva su
área mínima de 44 puntos, etiqueta accesible y acción. La barra admite scroll
en ventanas bajas y el tirador plegado conserva su posición segura. Su altura
incluye ocho puntos de margen interior. Abrirla, plegarla o activar un botón
no vuelve a montar el receptor de video.

Se utiliza material `regular` en la cápsula y el efecto interactivo nativo.
`GlassSurface` conserva la detección de API/build y usa una superficie sólida
cuando no hay Liquid Glass o se activa reducir transparencia. El prototipo
no captura el video ni calcula su desenfoque en CPU. Falta comparar presión,
reflejos y legibilidad con la referencia en un iPhone real; no se afirma que
se replique la implementación privada de WhatsApp.

El catálogo `mobile/src/lib/actions.ts` reúne los identificadores semánticos,
etiquetas y símbolos de cada acción existente. iOS usa SF Symbols y
Android/web sus equivalentes Material. El código anterior entregaba strings
SF Symbols a todas las plataformas y podía dejar controles sin icono.
`ActionIcon` conserva un carácter reconocible mientras se carga la fuente o
si falla. La implementación `.ios.tsx` usa los símbolos del sistema sin
importar la fuente Material. Los botones conservan una única activación y
una única llamada háptica por pulsación; no se agregó háptica al icono.

Los menús, el teclado, las flechas, los adjuntos y la selección de equipo usan
el catálogo. La sustitución del menú por uno nativo, las hojas, preferencias
por dispositivo y controles adicionales de P05.13–P05.15 siguen pendientes.

## Verificación

Pasaron typecheck, las 174 pruebas móviles existentes y los exports Hermes
para iOS y Android. Las pruebas de la barra conservan plegado, cuatro
comandos, ventana baja, teclado y consumo local de pulsaciones. Las pruebas
del menú y compositor conservan permisos, selección de archivos, foco y
recuperación de contenido. Los logs y exports están en `outputs/p05`.

Se revisaron los hooks, el estado fuera de los iconos y el uso de componentes
Expo existentes. No se añadieron dependencias ni APIs nativas nuevas. Los
exports verifican el bundle, no constituyen IPA/APK ni prueban Metal,
VoiceOver/TalkBack, carga real de fuentes o interacción del vidrio. La
aceptación física y las mediciones de P05.11/P05.12 permanecen pendientes.

Fuentes: [Expo Symbols 57](https://docs.expo.dev/versions/v57.0.0/sdk/symbols/)
y [Expo GlassEffect 57](https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/),
contrastadas con los paquetes locales 57.0.2.

Rollback: revertir este bloque JS conserva configuración, contenido y
sesiones. No se publicó OTA ni se modificó el binario instalado.
