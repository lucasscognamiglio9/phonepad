"""Check only the isolated compositor after its capture worker dies."""
import json,os,pathlib
from gi.repository import Gio, GLib
root=pathlib.Path(os.environ['PHONEPAD_HFR_ROOT'])
if not str(root).startswith('/tmp/phonepad-hfr-') or str(root) not in os.environ.get('DBUS_SESSION_BUS_ADDRESS',''):
    raise RuntimeError('Not a lab bus')
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
state=bus.call_sync('org.gnome.Mutter.DisplayConfig','/org/gnome/Mutter/DisplayConfig','org.gnome.Mutter.DisplayConfig','GetCurrentState',None,None,Gio.DBusCallFlags.NONE,5000,None).unpack()
connectors=[m[0][0] for m in state[1]]
result={'fault':'capture worker SIGKILL','compositorAlive':True,'connectors':connectors,'originalMonitorRestored':len(connectors)==1 and connectors[0]=='Meta-0','scope':'isolated GNOME only'}
(root/'result.json').write_text(json.dumps(result,indent=2));(root/'motion.h264').touch()
if not result['originalMonitorRestored']:raise RuntimeError('Fault left an extra monitor')
