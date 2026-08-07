# ADR 0001 — Pairing persistente entre reinicios

Estado: aceptado · Fecha: 2026-06-01

## Contexto

El token de pairing era efímero: se regeneraba en cada arranque del daemon
(`genToken` en `main.go`). El SPEC original lo listaba como no-goal "persistencia
de pairing entre reinicios".

El objetivo de producto pasó a ser "prender phonepad y entrar desde el celular
con un acceso directo (ícono PWA), sin re-escanear el QR". Con token efímero eso
es imposible: cada reinicio del daemon invalida el token guardado en el cel, así
que el ícono dejaría de conectar. El daemon además se prende/apaga on-demand
desde un toggle de Quick Settings (ADR del setup), o sea reinicia seguido.

## Decisión

Persistir el token en `~/.config/phonepad/pairing.json` (0600, junto al cert) y
reusarlo entre reinicios. Encapsular la credencial en un módulo profundo
`internal/pairing` con interfaz chica:

- `Open(dir)` carga o genera el token estable.
- `Valid(token)` compara en **tiempo constante** (`subtle.ConstantTimeCompare`).
- `Paired()` / `MarkPaired()` registran el primer emparejamiento (lo consulta el
  toggle para no reabrir `/pair` en cada arranque).
- `Rotate()` revoca (token nuevo + des-emparejado) si el QR se filtra.

El server depende de la interfaz `Authenticator`, no de un `string` suelto. El
cliente guarda el token en `localStorage` y lo limpia de la URL para no dejarlo
en el historial.

## Consecuencias

- (+) El ícono PWA del cel conecta sin re-escanear; QR de una sola vez.
- (+) La credencial queda en un solo lugar testeable; `Rotate` da revocación.
- (+) `Valid` constant-time + token fuera de la URL del historial: mejor postura.
- (−) Un secreto persiste en disco (0600). Aceptable en el modelo (LAN casera,
  1 usuario). Quien lea `~/.config/phonepad` tendría control hasta `Rotate`.
- Modelo de amenaza: la barrera real es red (LAN) + token de 192 bits; el Origin
  del WS no aporta (se desactiva su verificación a propósito).
