> Revisión 2026-09-08: consultar README.md, docs/verificacion-2026-09-08.md y ADR 0007 para bind local, video e iPhone. El contenido previo se conserva como historia del contrato.

# Verificación end-to-end — setup express

Lo automatizable ya está verificado (build, tests, `systemctl start/stop`,
endpoints PWA, persistencia del token). Lo que sigue requiere **vos** (logout +
el celular) y cierra la evidencia del flujo completo.

## 0. Instalación (una vez)

```bash
sudo bash setup/setup.sh        # uinput + grupo input + wl-clipboard  (relogin después)
bash setup/install.sh           # binario + servicio + extensión GNOME
```

⚠ En Wayland, **cerrá sesión y volvé a entrar** para que GNOME vea la extensión,
luego (si no se habilitó sola): `gnome-extensions enable phonepad@local`.

## 1. Toggle de Quick Settings (lado laptop)

- [ ] Abrí Quick Settings → aparece el toggle **phonepad**.
- [ ] Tocá ON → el toggle queda encendido y `systemctl --user is-active phonepad`
      devuelve `active`.
- [ ] La 1ª vez (sin cel emparejado) se **abre `/pair`** en el navegador con el QR.
      (Aceptá el aviso de certificado casero: Avanzado → Continuar.)
- [ ] Tocá OFF → `is-active` devuelve `inactive` (no corre nada).
- [ ] Prendé/apagá el daemon por fuera (`systemctl --user start phonepad`) → el
      toggle se sincroniza solo en ≤5s.

La vista `/pair` se abre en `https://localhost:8080/pair` y no se expone a otros
hosts de la LAN. `/api/pair-info` no debe contener `token=`; una petición desde
otra IP debe recibir `403`.

## 2. Acceso directo del celular (PWA)

- [ ] Escaneá el QR de `/pair` → abre la PWA en el cel (aceptá el cert una vez).
- [ ] En el menú del navegador: **Agregar a pantalla de inicio** → ícono propio.
- [ ] La URL del cel ya **no** muestra `?token=...` (se limpió al historial).
- [ ] Cerrá la PWA. Tocá el **ícono** → abre full-screen y **conecta sin re-escanear**.
- [ ] Reiniciá el daemon (toggle OFF/ON) → el ícono **sigue conectando** (token
      persistente). El QR ya no se abre solo (porque `paired=true`).

## 3. Funcionalidad (el fix de texto + lo de siempre)

- [ ] Mover cursor, tap (click izq), 2 dedos (click der / scroll), 3 dedos (gestos).
- [ ] Teclado: escribí **ASCII** en un editor GUI → aparece. ✓ era lo roto-base.
- [ ] Escribí **acentos/ñ/emoji** (ej. `café ñoño 🚀`) en un editor GUI → aparece
      (vía clipboard). Nota: en **GNOME Terminal** el Unicode no aparece (paste es
      Ctrl+Shift+V); el ASCII sí. Límite documentado (ADR 0002).
- [ ] Micrófono (Chrome/HTTPS): dictá → el texto final aparece en la laptop.

## 4. Rollback / revocación

- [ ] Con el servicio detenido, ejecutar `~/.local/bin/phonepad --rotate-token` y
      volver a iniciarlo → genera token nuevo y el cel debe re-escanear (revocación).
- [ ] Borrar `~/.config/phonepad/pairing.json` sigue siendo un fallback manual:
      el próximo arranque regenera el estado, pero no expone la credencial.
