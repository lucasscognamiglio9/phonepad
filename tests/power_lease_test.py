import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup/preview'))
from power_lease import PowerLease
from gi.repository import GLib

class Bus:
 def __init__(self):self.battery=False;self.holds=0;self.releases=0;self.fail=False
 def call_sync(self,destination,path,interface,method,args,*rest):
  if self.fail:raise RuntimeError('daemon unavailable')
  if method=='Get':return GLib.Variant('(v)',(GLib.Variant('b',self.battery),))
  if method=='HoldProfile':self.holds+=1;return GLib.Variant('(u)',(7,))
  if method=='ReleaseProfile':self.releases+=1;return GLib.Variant('()',())

class Tests(unittest.TestCase):
 def test_pause_resume_and_exit_release_owned_hold(self):
  bus=Bus();lease=PowerLease(bus)
  lease.set_active(True);lease.refresh(force=True);self.assertEqual(bus.holds,1)
  lease.set_active(False);self.assertEqual(bus.releases,1)
  lease.set_active(True);lease.close();lease.close()
  self.assertEqual((bus.holds,bus.releases),(2,2))
 def test_battery_never_acquires_and_unplug_releases(self):
  bus=Bus();lease=PowerLease(bus);bus.battery=True
  lease.set_active(True);self.assertEqual(bus.holds,0)
  bus.battery=False;lease.refresh(force=True);self.assertEqual(bus.holds,1)
  bus.battery=True;lease.refresh(force=True);self.assertEqual(bus.releases,1)
 def test_unavailable_daemon_does_not_break_streaming(self):
  bus=Bus();bus.fail=True;lease=PowerLease(bus)
  lease.set_active(True);self.assertIsNone(lease.cookie)
  bus.fail=False;lease.refresh(force=True);self.assertEqual(bus.holds,1);lease.close()
if __name__=='__main__':unittest.main()
