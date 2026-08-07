# CONTEXT — phonepad

Glosario del lenguaje ubicuo. Sin detalles de implementación: solo qué significa
cada término del dominio. Las decisiones viven en `docs/adr/`; el contrato en `SPEC.md`.

---

## Contacto

Un dedo en contacto con la superficie del pad, identificado por un `id` estable
mientras dure el toque y una posición `(x, y)`. La unidad de información que el
celular reporta. Un toque de N dedos = N contactos simultáneos.

Reemplaza a la noción vieja de "evento de puntero clasificado": el cliente ya no
interpreta qué significan los contactos, solo los transporta.

## Gesto

⚠ Término en transición (ver [[touchpad-precision-emulado]]).

- **Sentido viejo (obsoleto):** una intención discreta de alto nivel que el
  cliente detectaba y nombraba (`overview`, `zoom-in`, `ws-left`…) y mandaba como
  mensaje `g`. El cliente era quien "decidía" el gesto.
- **Sentido nuevo:** la interpretación que hacen **libinput + GNOME** a partir del
  stream de contactos (swipe de 3 dedos, scroll de 2, pinch). phonepad ya **no
  nombra gestos**: emergen del sistema, igual que con el touchpad físico.

El gesto deja de ser vocabulario de phonepad y pasa a ser vocabulario del SO.

## Pad

La superficie táctil de la PWA donde el dedo toca. Antes contenía el clasificador
de gestos; ahora es la fuente de [[contacto]]s crudos.

## Touchpad de precisión emulado

El rol nuevo del daemon: presentarse ante el SO como un touchpad multitouch de
precisión real (vía uinput), de modo que **libinput clasifique los gestos
nativamente** y GNOME los anime 1:1. Invierte el principio viejo de "el cliente
clasifica, el server inyecta 1:1": ahora el cliente reenvía contactos y el daemon
emula un dispositivo con estado.

## Paridad total

El criterio de aceptación: phonepad debe producir **exactamente** los mismos
gestos y animaciones que el touchpad físico de la laptop, heredando la config de
GNOME del usuario (natural-scroll, tap-to-click, aceleración). Implica que el
pinch va a la app (zoom de contenido), no a la lupa de accesibilidad.
