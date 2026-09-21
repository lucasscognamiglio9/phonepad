import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup/preview'))
from cursor_lease import CursorSizeLease
class Settings:
 def __init__(self):self.size=24
 def get_int(self,key):return self.size
 def set_int(self,key,size):self.size=size;return True
class Tests(unittest.TestCase):
 def test_restore_and_external_change(self):
  s=Settings();lease=CursorSizeLease(s,96);lease.acquire();self.assertEqual(s.size,96);lease.close();self.assertEqual(s.size,24)
  lease=CursorSizeLease(s,96);lease.acquire();s.size=64;lease.close();self.assertEqual(s.size,64)
 def test_never_shrink_accessibility_cursor(self):
  s=Settings();s.size=128;lease=CursorSizeLease(s,96);lease.acquire();lease.close();self.assertEqual(s.size,128)
if __name__=='__main__':unittest.main()
