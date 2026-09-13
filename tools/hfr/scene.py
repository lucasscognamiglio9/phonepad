"""Number each animation update; captured barcode verifies unique frames."""
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib, Gdk
app = Gtk.Application(application_id='app.phonepad.HFRLab')
def activate(app):
    window = Gtk.ApplicationWindow(application=app)
    canvas = Gtk.Fixed()
    css = Gtk.CssProvider()
    css.load_from_string('.black { background: #000; } .white { background: #fff; } .scene { background: #171a20; } .bar { background: #30aacc; } label { color: white; font: 24px monospace; }')
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    canvas.add_css_class('scene')
    cells = []
    for bit in range(20):
        cell = Gtk.Box(); cell.set_size_request(16, 16)
        canvas.put(cell, 16 + bit * 16, 16); cells.append(cell)
    bar = Gtk.Box(); bar.set_size_request(100, 900); bar.add_css_class('bar'); canvas.put(bar, 0, 90)
    for y in range(140, 1080, 48):
        canvas.put(Gtk.Label(label='Phonepad 1080p — texto y movimiento'), 90, y)
    sequence = [0]
    previous = [None] * 20
    def tick(widget, clock):
        sequence[0] += 1
        canvas.move(bar, (sequence[0] * 9) % 1920, 90)
        values = [1, 0, 1, 0] + [(sequence[0] >> i) & 1 for i in range(16)]
        for i, (cell, value) in enumerate(zip(cells, values)):
            if previous[i] != value:
                cell.set_css_classes(['white' if value else 'black'])
                previous[i] = value
        return True
    canvas.add_tick_callback(tick)
    window.set_child(canvas); window.fullscreen(); window.present()
    GLib.timeout_add_seconds(180, lambda: (app.quit(), False)[1])
app.connect('activate', activate)
app.run(None)
