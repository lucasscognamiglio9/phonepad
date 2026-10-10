"""Fixture editor for literal input, strictly on the private laboratory bus."""
import json
import os
from pathlib import Path
import subprocess
import threading
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib, Gio
root = Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS', ''):
    raise RuntimeError('Refusing non-lab editor')
repo = Path(__file__).resolve().parents[2]
corpus = json.loads((repo/'tests/fixtures/input-integrity.json').read_text())['textCases']
corpus += [{'name':'100-KiB','value':'x'*102400}]
results = []
clipboard_ok = None
app = Gtk.Application(application_id='app.phonepad.InputLab')

def activate(app):
    window = Gtk.ApplicationWindow(application=app, title='PhonePad synthetic text fixture')
    view = Gtk.TextView(); window.set_child(view); window.set_default_size(800, 500)
    window.present(); view.grab_focus()
    def run_next():
        index = len(results)
        if index == len(corpus):
            (root/'input-result.json').write_text(json.dumps({'scope':'private GTK editor via AT-SPI, not phone/browser/terminal', 'cases':results},indent=2))
            if os.environ.get('PHONEPAD_LAB_CLIPBOARD') == '1':
                from clipboard_lab import verify
                def finished(ok):
                    global clipboard_ok
                    clipboard_ok = ok
                    app.quit()
                verify(root, repo, finished)
            else:
                app.quit()
            return False
        sample = corpus[index]
        view.get_buffer().set_text(''); view.grab_focus()
        def work():
            try:
                probe = subprocess.run(['/usr/bin/python3', str(repo/'daemon/internal/input/literal_text.py')], input=json.dumps({'op':'probe'}),text=True,capture_output=True,timeout=8)
                target = json.loads(probe.stdout).get('target')
                proc = subprocess.run(['/usr/bin/python3', str(repo/'daemon/internal/input/literal_text.py')],
                    input=json.dumps({'op':'insert','text':sample['value'],'target':target}),text=True,capture_output=True,timeout=8)
                (root/f'input-helper-{index}.log').write_text(proc.stderr)
                result = json.loads(proc.stdout)
            except Exception:
                result = {'state':'uncertain','detail':'fixture_helper_failed'}
            def verify():
                buffer = view.get_buffer()
                actual = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)
                results.append({'name':sample['name'], 'bytes':len(sample['value'].encode()),
                                'receipt':result, 'exact':actual==sample['value'], 'actualBytes':len(actual.encode())})
                GLib.timeout_add(200, run_next)
                return False
            GLib.idle_add(verify)
        threading.Thread(target=work, daemon=True).start()
        return False
    def focus_fixture():
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            service = 'org.gnome.Mutter.RemoteDesktop'
            def call(path, iface, method, args=None):
                return bus.call_sync(service, path, iface, method, args, None, Gio.DBusCallFlags.NONE, 3000, None)
            session = call('/org/gnome/Mutter/RemoteDesktop', service, 'CreateSession').unpack()[0]
            interface = service + '.Session'
            description = call(session, 'org.freedesktop.DBus.Introspectable', 'Introspect').unpack()[0]
            (root/'input-session.xml').write_text(description)
            call(session, interface, 'Start')
            call(session, interface, 'NotifyKeyboardKeysym', GLib.Variant('(ub)', (0xff1b, True)))
            call(session, interface, 'NotifyKeyboardKeysym', GLib.Variant('(ub)', (0xff1b, False)))
            def click_editor():
                call(session, interface, 'NotifyPointerMotionRelative', GLib.Variant('(dd)', (-10000., -10000.)))
                call(session, interface, 'NotifyPointerMotionRelative', GLib.Variant('(dd)', (960., 540.)))
                call(session, interface, 'NotifyPointerButton', GLib.Variant('(ib)', (272, True)))
                call(session, interface, 'NotifyPointerButton', GLib.Variant('(ib)', (272, False)))
                view.grab_focus()
                GLib.timeout_add(500, run_next)
                return False
            GLib.timeout_add(500, click_editor)
            return False
        except Exception as error:
            (root/'input-focus.log').write_text(str(error))
        GLib.timeout_add(500, run_next)
        return False
    GLib.timeout_add(1500, focus_fixture)
app.connect('activate', activate)
app.run([])
if clipboard_ok is False:
    raise SystemExit(1)
if not results or not all(case['exact'] and case['receipt']['state']=='dispatched' for case in results):
    raise SystemExit(1)
