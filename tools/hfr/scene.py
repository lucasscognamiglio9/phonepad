"""Number each animation update; captured barcode verifies unique frames."""
import os
import gi
from scene_model import frame_state, TEXT
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib, Gdk
app = Gtk.Application(application_id='app.phonepad.HFRLab')
def activate(app):
    window = Gtk.ApplicationWindow(application=app)
    canvas = Gtk.Fixed()
    css = Gtk.CssProvider()
    css.load_from_string('.black { background: #000; } .white { background: #fff; } .scene { background: #171a20; } .bar { background: #30aacc; } label { color: white; font: 24px monospace; }' +
                         ''.join(f'.sample-{size} {{ font: {size}px monospace; }}' for size in (10, 12, 14, 16)) +
                         '.red { color: #ff5555; } .green { color: #55ff55; } .blue { color: #5555ff; }')
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    canvas.add_css_class('scene')
    cells = []
    for bit in range(20):
        cell = Gtk.Box(); cell.set_size_request(16, 16)
        canvas.put(cell, 16 + bit * 16, 16); cells.append(cell)
    bar = Gtk.Box(); bar.set_size_request(100, 900); bar.add_css_class('bar'); canvas.put(bar, 0, 90)
    for y in range(140, 1080, 48):
        canvas.put(Gtk.Label(label='Phonepad 1080p — texto y movimiento'), 90, y)
    # Fixed regions make color/text comparisons alignable across candidates.
    for row, size in enumerate((10, 12, 14, 16)):
        for column, color in enumerate(('white', 'red', 'green', 'blue')):
            label = Gtk.Label(label=TEXT)
            label.add_css_class(f'sample-{size}')
            if color != 'white': label.add_css_class(color)
            canvas.put(label, 20 + column * 470, 40 + row * 24)
    for x in range(1400, 1528, 2):
        line = Gtk.Box(); line.set_size_request(1, 100); line.add_css_class('white')
        canvas.put(line, x, 940)
    clicks = [0]
    button = Gtk.Button(label='Click fixture: 0')
    button.set_size_request(280, 60)
    def clicked(button):
        clicks[0] += 1
        button.set_label(f'Click fixture: {clicks[0]}')
    button.connect('clicked', clicked)
    canvas.put(button, 1600, 940)
    sequence = [0]
    previous = [None] * 20
    profile = os.environ.get('PHONEPAD_LAB_SCENE_PROFILE', 'motion')
    frame_state(0, profile)  # Fail early for an unsupported profile.
    def tick(widget, clock):
        sequence[0] += 1
        state = frame_state(sequence[0], profile)
        canvas.move(bar, state['bar_x'], 90)
        values = state['barcode']
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
