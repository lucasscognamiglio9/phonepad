"""Only expose the production mirror to an isolated test compositor."""
import os, pathlib, sys
root=os.environ.get('PHONEPAD_HFR_ROOT','')
if not root.startswith('/tmp/phonepad-hfr-') or root not in os.environ.get('DBUS_SESSION_BUS_ADDRESS',''):
    raise RuntimeError('Refusing virtual mirror outside the isolated laboratory')
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'setup/preview'))
from virtual_source import Mirror, layout
