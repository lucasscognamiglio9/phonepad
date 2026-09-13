#!/usr/bin/python3
"""Phonepad panel indicator. Event-driven status; no capture or polling."""
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gtk, Gdk, Gio, GLib, AyatanaAppIndicator3 as Indicator

public_url = 'https://localhost:8080/'
try:
    for line in (Path.home() / '.config/phonepad/service.env').read_text().splitlines():
        if line.startswith('PHONEPAD_PUBLIC_URL='):
            public_url = line.split('=', 1)[1].strip().rstrip('/') + '/'
except OSError:
    pass

indicator = Indicator.Indicator.new('phonepad', 'input-touchpad-symbolic',
                                    Indicator.IndicatorCategory.APPLICATION_STATUS)
indicator.set_title('Phonepad')
indicator.set_status(Indicator.IndicatorStatus.ACTIVE)
menu = Gtk.Menu()
status = Gtk.MenuItem(label='Phonepad')
status.set_sensitive(False)
menu.append(status)
menu.append(Gtk.SeparatorMenuItem())


def restart(_):
    status.set_label('Phonepad · reiniciando…')
    process = Gio.Subprocess.new(['systemctl', '--user', 'restart', 'phonepad', 'phonepad-preview'],
                                Gio.SubprocessFlags.NONE)
    def finished(process, result):
        try:
            process.wait_check_finish(result)
            refresh()
        except GLib.Error:
            status.set_label('Phonepad · no se pudo reiniciar')
    process.wait_check_async(None, finished)


def copy_link(_):
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_text(public_url, -1)
    clipboard.store()


for label, action in [('Reiniciar Phonepad', restart), ('Copiar enlace', copy_link),
                      ('Vincular otro teléfono…', lambda _: Gio.AppInfo.launch_default_for_uri('https://localhost:8080/pair', None))]:
    item = Gtk.MenuItem(label=label)
    item.connect('activate', action)
    menu.append(item)
menu.show_all()
indicator.set_menu(menu)

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
destination = 'org.freedesktop.systemd1'
manager_path = '/org/freedesktop/systemd1'
manager_interface = 'org.freedesktop.systemd1.Manager'
bus.call_sync(destination, manager_path, manager_interface, 'Subscribe', None, None,
              Gio.DBusCallFlags.NONE, 3000, None)
unit_path = bus.call_sync(destination, manager_path, manager_interface, 'LoadUnit',
                          GLib.Variant('(s)', ('phonepad.service',)), None,
                          Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
unit = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None, destination,
                             unit_path, 'org.freedesktop.systemd1.Unit', None)


def refresh(*_):
    value = unit.get_cached_property('ActiveState')
    active = value is not None and value.unpack() == 'active'
    status.set_label('Phonepad · activo' if active else 'Phonepad · detenido')
    indicator.set_icon_full('input-touchpad-symbolic', 'Phonepad activo' if active else 'Phonepad detenido')


unit.connect('g-properties-changed', refresh)
refresh()
Gtk.main()
