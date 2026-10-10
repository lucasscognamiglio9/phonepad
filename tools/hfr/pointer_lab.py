"""Observe actual pointer events in a GTK window on the private compositor."""
import json, os
from pathlib import Path
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib
root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS', ''):
    raise RuntimeError('Refusing non-lab pointer fixture')
app = Gtk.Application(application_id='app.phonepad.PointerLab')
events = []
def activate(app):
    window = Gtk.ApplicationWindow(application=app, title='PhonePad pointer fixture')
    area = Gtk.DrawingArea()
    frames = [0]
    def tick(widget, _clock):
        frames[0] += 1
        widget.queue_draw()
        return True
    area.add_tick_callback(tick)
    motion = Gtk.EventControllerMotion()
    motion.connect('motion', lambda _c, x, y: events.append({'kind':'motion','x':x,'y':y}))
    # A single native move entering the window emits enter rather than motion.
    # Both carry real GTK coordinates; the first snapshot must observe either.
    motion.connect('enter', lambda _c, x, y: events.append({'kind':'motion','x':x,'y':y}))
    area.add_controller(motion)
    click = Gtk.GestureClick()
    click.set_button(1)
    for kind in ('pressed', 'released'):
        click.connect(kind, lambda _c, n, x, y, kind=kind: events.append({'kind':kind,'count':n,'x':x,'y':y}))
    area.add_controller(click)
    window.set_child(area)
    window.set_default_size(1200, 700)
    window.fullscreen()
    window.present()
    def ready():
        (root/'pointer-ready').touch()
        return False
    GLib.timeout_add(2000, ready)
    def poll():
        request = root/'pointer-request.json'
        if request.exists():
            case = json.loads(request.read_text())['case']
            request.unlink()
            (root/('pointer-result-'+case+'.json')).write_text(json.dumps(events))
            (root/('pointer-state-'+case+'.json')).write_text(json.dumps({
                'mapped':window.get_mapped(), 'areaMapped':area.get_mapped(),
                'width':area.get_width(), 'height':area.get_height(), 'frames':frames[0]}))
            events.clear()
        if (root/'pointer-done').exists():
            app.quit()
            return False
        return True
    GLib.timeout_add(10, poll)
app.connect('activate', activate)
app.run([])
