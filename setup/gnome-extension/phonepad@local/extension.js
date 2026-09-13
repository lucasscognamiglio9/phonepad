// Extensión GNOME 50: un toggle de Quick Settings (estilo Caffeine) que
// prende/apaga el servicio systemd de usuario `phonepad` y, en el primer
// emparejamiento, abre la vista /pair en el navegador.
//
// Decisiones (ver grilla de diseño):
// - El estado del toggle se deriva de `systemctl --user is-active` → queda en
//   sync aunque el daemon se prenda/apague por otra vía.
// - "paired" se lee del pairing.json local (sin HTTP ni cert self-signed).
// - Al prender, abre /pair SOLO si todavía no hay un dispositivo emparejado.
// - El menú del toggle tiene una acción "Mostrar QR / emparejar" que abre /pair
//   SIEMPRE (a demanda), independiente del estado de emparejamiento.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SERVICE = 'phonepad.service';
// Puerto por defecto del daemon (main.go: flag --port, default 8080). Si lo
// cambiás en la unit, cambialo acá también.
const PAIR_URL = 'https://localhost:8080/pair';
const PAIRING_JSON = GLib.build_filenamev([GLib.get_user_config_dir(), 'phonepad', 'pairing.json']);

// runAsync ejecuta argv y llama cb(ok) sin bloquear el shell.
function runAsync(argv, cb) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        proc.wait_check_async(null, (p, res) => {
            let ok = false;
            try { ok = p.wait_check_finish(res); } catch (_e) { ok = false; }
            if (cb) cb(ok);
        });
    } catch (_e) {
        if (cb) cb(false);
    }
}

// isActive consulta `systemctl --user is-active phonepad` → cb(active:boolean).
function isActive(cb) {
    try {
        const proc = Gio.Subprocess.new(
            ['systemctl', '--user', 'is-active', SERVICE],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            let active = false;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                active = (stdout || '').trim() === 'active';
            } catch (_e) { /* ignore */ }
            cb(active);
        });
    } catch (_e) {
        cb(false);
    }
}

// isPaired lee el pairing.json del daemon: true si ya se emparejó un cel.
function isPaired() {
    try {
        const [ok, contents] = GLib.file_get_contents(PAIRING_JSON);
        if (!ok) return false;
        const data = JSON.parse(new TextDecoder().decode(contents));
        return data.paired === true;
    } catch (_e) {
        return false;
    }
}

function openPair() {
    try {
        Gio.AppInfo.launch_default_for_uri(PAIR_URL, null);
    } catch (_e) { /* ignore */ }
}

// osd muestra un toast centrado tipo Caffeine (ícono + texto, sin barra de nivel).
//
// GNOME 49/50 partió el viejo `show(monitorIndex, icon, label, level, maxLevel)`
// en tres métodos. Para un toast en todos los monitores se usa
// `showAll(icon, label, level)`; con level === null no se dibuja la barra de
// nivel (sólo ícono + texto), que es justo lo que queremos.
function osd(label) {
    try {
        const icon = new Gio.ThemedIcon({name: 'input-touchpad-symbolic'});
        Main.osdWindowManager.showAll(icon, label, null);
    } catch (_e) { /* ignore */ }
}

const PhonepadToggle = GObject.registerClass(
class PhonepadToggle extends QuickMenuToggle {
    _init() {
        super._init({
            title: 'Phonepad',
            subtitle: 'Disponible al iniciar sesión',
            iconName: 'input-touchpad-symbolic',
            toggleMode: true,
        });

        // Header del menú desplegable (la flechita al lado del toggle).
        this.menu.setHeader('input-touchpad-symbolic', 'phonepad');

        // Acción a demanda: abre /pair SIEMPRE, sin importar si ya hay un cel
        // emparejado (sirve para re-escanear el QR o emparejar otro dispositivo).
        this.menu.addAction('Vincular teléfono / mostrar QR', () => this._startAndOpen(PAIR_URL));
        this.menu.addAction('Ver y compartir escritorio', () => this._startAndOpen('https://localhost:8080/share'));
        this.menu.addAction('Activar inicio automático', () => runAsync(['systemctl', '--user', 'enable', SERVICE], ok => osd(ok ? 'Inicio automático activado' : 'No se pudo activar')));
        this.menu.addAction('Desactivar inicio automático', () => runAsync(['systemctl', '--user', 'disable', SERVICE], ok => osd(ok ? 'Inicio automático desactivado' : 'No se pudo desactivar')));
        this._alive = true;
        this._openingTimer = null;
        this._busy = false;

        this.connect('clicked', () => this._onClicked());
        this._refresh();

        // Mantener el estado en sync (por si se prende/apaga por fuera).
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        if (this._busy) return;
        isActive((active) => {
            if (!this._alive || this._busy) return;
            this.checked = active;
            this.subtitle = active ? 'Disponible · conexión automática' : 'Apagado';
        });
    }

    _startAndOpen(url) {
        runAsync(['systemctl', '--user', 'start', SERVICE], ok => {
            if (!this._alive) return;
            if (!ok) { osd('No se pudo iniciar Phonepad'); this._refresh(); return; }
            if (this._openingTimer) GLib.source_remove(this._openingTimer);
            this._openingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                this._openingTimer = null;
                if (this._alive) Gio.AppInfo.launch_default_for_uri(url, null);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _onClicked() {
        if (this._busy) return;
        this._busy = true;
        const enabled = this.checked;
        this.subtitle = enabled ? 'Iniciando…' : 'Deteniendo…';
        runAsync(['systemctl', '--user', enabled ? 'start' : 'stop', SERVICE], ok => {
            if (!this._alive) return;
            this._busy = false;
            this._refresh();
            if (!ok) { osd('No se pudo cambiar Phonepad'); return; }
            osd(enabled ? 'Phonepad disponible' : 'Phonepad apagado');
            if (enabled && !isPaired()) this._startAndOpen(PAIR_URL);
        });
    }

    destroy() {
        this._alive = false;
        if (this._openingTimer) { GLib.source_remove(this._openingTimer); this._openingTimer = null; }
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

const PhonepadIndicator = GObject.registerClass(
class PhonepadIndicator extends SystemIndicator {
    _init() {
        super._init();
        this.quickSettingsItems.push(new PhonepadToggle());
    }
});

export default class PhonepadExtension extends Extension {
    enable() {
        this._indicator = new PhonepadIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach((item) => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
