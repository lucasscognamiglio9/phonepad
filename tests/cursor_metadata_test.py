import pathlib,sys,struct,zlib,unittest,json,tempfile
from types import SimpleNamespace
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup/preview'))
from cursor_metadata import png_rgba,CursorSender
from cursor_theme import CursorTheme,frames
class CursorTests(unittest.TestCase):
 def test_png_alpha_and_bounds(self):
  image=png_rgba(1,1,bytes([64,32,0,128]));self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
  pos=8;raw=None
  while pos<len(image):
   size=struct.unpack('>I',image[pos:pos+4])[0];kind=image[pos+4:pos+8];body=image[pos+8:pos+8+size]
   if kind==b'IDAT':raw=zlib.decompress(body)
   pos+=12+size
  self.assertEqual(raw,bytes([0,128,64,0,128]))
  for args in [(0,1,b''),(257,1,b''),(1,1,b'')]:
   with self.assertRaises(ValueError):png_rgba(*args)
 def test_backpressure_coalesces_and_suspension_does_not_send(self):
  sent=[];state={'buffered-amount':1,'ready-state':2}
  channel=SimpleNamespace(get_property=lambda k:state[k],emit=lambda _,v:sent.append(json.loads(v)))
  session=SimpleNamespace(closed=False,suspended=False,cursor_channel=channel,cursor_open_state=2)
  reader=SimpleNamespace(failed=False,snapshot=lambda:(3,{'visible':False}),close=lambda:None)
  glib=SimpleNamespace(timeout_add=lambda *_:1,source_remove=lambda _:None)
  sender=CursorSender(session,reader,glib)
  sender.send();self.assertEqual(sent,[])
  state['buffered-amount']=0;session.suspended=True;sender.send();self.assertEqual(sent,[])
  session.suspended=False;sender.send();self.assertEqual(len(sent),1);self.assertEqual(sent[0]['sequence'],1)
  sender.send();self.assertEqual(len(sent),1)
  sender.close()
class ThemeTests(unittest.TestCase):
 def fixture(self):
  low=bytes([80,40,20,255])*4
  high=bytes([90,45,22,255])*16
  chunks=[]
  for size,pixels in [(2,low),(4,high)]:
   bgra=bytearray(pixels);bgra[0::4],bgra[2::4]=pixels[2::4],pixels[0::4]
   chunks.append(struct.pack('<9I',36,0xfffd0002,size,1,size,size,1,1,0)+bgra)
  head=struct.pack('<4I',0x72756358,16,1,2);offset=40
  for size,chunk in zip([2,4],chunks):head+=struct.pack('<3I',0xfffd0002,size,offset);offset+=len(chunk)
  return head+b''.join(chunks),low,high
 def test_exact_theme_frame_uses_higher_resolution_without_guessing_custom_cursor(self):
  data,low,high=self.fixture()
  with tempfile.TemporaryDirectory() as root:
   folder=pathlib.Path(root);(folder/'arrow').write_bytes(data)
   theme=CursorTheme([folder])
   self.assertEqual(theme.resolve(2,2,low),(4,4,1,1,high))
   self.assertIsNone(theme.resolve(2,2,bytes([0,0,0,0])*4))
 def test_truncated_theme_cannot_supply_partial_pixels(self):
  data,_,_=self.fixture()
  self.assertEqual(frames(b''),[])
  self.assertEqual(len(frames(data[:-1])),1)
  self.assertEqual(frames(b'bad!'+data[4:]),[])

if __name__=='__main__':unittest.main()
