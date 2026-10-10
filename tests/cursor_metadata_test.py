import pathlib,sys,struct,zlib,unittest,json,tempfile,queue,threading,time
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup/preview'))
from cursor_metadata import png_rgba,CursorSender,CursorMetadata
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
 def test_reliable_shape_backpressure_never_blocks_small_latest_positions(self):
  positions=[];images=[]
  position_props={'buffered-amount':0,'ready-state':2};image_props={'buffered-amount':100,'ready-state':2}
  channel=lambda props,sent:SimpleNamespace(get_property=lambda k:props[k],emit=lambda _,v:sent.append(json.loads(v)))
  session=SimpleNamespace(closed=False,suspended=False,cursor_channel=channel(position_props,positions),cursor_image_channel=channel(image_props,images),cursor_open_state=2,cursor_delivery=2)
  state={'visible':True,'x':10,'y':20,'w':96,'h':96,'hx':4,'hy':5,'imageId':'0123456789abcdef','image':'data:image/png;base64,'+'A'*50000}
  version=[1]
  reader=SimpleNamespace(failed=False,snapshot=lambda:(version[0],dict(state)),close=lambda:None)
  glib=SimpleNamespace(timeout_add=lambda *_:1,source_remove=lambda _:None)
  sender=CursorSender(session,reader,glib)
  for i in range(100):
   version[0]+=1;state['x']=i;sender.send()
  self.assertEqual(len(positions),100);self.assertEqual(images,[])
  self.assertTrue(all(len(json.dumps(p))<500 and 'image' not in p for p in positions))
  image_props['buffered-amount']=0;sender.send()
  self.assertEqual(len(images),1);self.assertEqual(images[0]['t'],'cursor-image');self.assertEqual(images[0]['version'],2)
  sender.send();self.assertEqual(len(images),1)
  # Position congestion drops old snapshots; no trail gets replayed later.
  position_props['buffered-amount']=1
  for i in range(20): version[0]+=1;state['x']=200+i;sender.send()
  position_props['buffered-amount']=0;sender.send()
  self.assertEqual(positions[-1]['x'],219);self.assertEqual(len(positions),101)
  sender.close()
 def test_legacy_bitmap_is_resent_during_continuous_movement(self):
  sent=[];channel=SimpleNamespace(get_property=lambda k:2 if k=='ready-state' else 0,emit=lambda _,v:sent.append(json.loads(v)))
  session=SimpleNamespace(closed=False,suspended=False,cursor_channel=channel,cursor_open_state=2)
  state={'visible':True,'x':0,'imageId':'0123456789abcdef','image':'png'};version=[0]
  reader=SimpleNamespace(failed=False,snapshot=lambda:(version[0],dict(state)),close=lambda:None)
  sender=CursorSender(session,reader,SimpleNamespace(timeout_add=lambda *_:1,source_remove=lambda _:None))
  with patch('cursor_metadata.time.monotonic') as clock:
   for tick in range(180):
    clock.return_value=10+tick/60;state['x']=tick;version[0]+=1;sender.send()
  self.assertEqual(len(sent),180);self.assertEqual(sum('image' in p for p in sent),3)
  sender.close()
class ReaderTests(unittest.TestCase):
 def test_slow_shape_decoding_does_not_block_positions_or_restore_an_old_position(self):
  reader=CursorMetadata.__new__(CursorMetadata)
  reader.lock=threading.Lock();reader.ready=threading.Event();reader.failed=False
  reader.latest={'visible':False};reader.version=0;reader.image_scale=(1,1);reader.hotspot_offset=(0,0)
  reader.jobs=queue.Queue(maxsize=1);reader.stopping=threading.Event();reader.shape_generation=0;reader.applied_shape=0
  lines=queue.Queue();entered=threading.Event();release=threading.Event();decoded=[]
  def resolve(w,h,pixels):
   decoded.append(w)
   if len(decoded)==1:entered.set();release.wait(2)
   return None
  reader.theme=SimpleNamespace(resolve=resolve)
  reader.process=SimpleNamespace(stdout=SimpleNamespace(readline=lambda _:lines.get(timeout=3)))
  read=threading.Thread(target=reader.read);shapes=threading.Thread(target=reader.shapes)
  read.start();shapes.start()
  def send(value):lines.put(json.dumps(value).encode()+b'\n')
  def wait(predicate):
   deadline=time.monotonic()+1
   while not predicate() and time.monotonic()<deadline:time.sleep(.001)
   self.assertTrue(predicate())
  try:
   send({'x':0,'y':0,'visible':True,'hx':0,'hy':0,'w':1,'h':1,'rgba':'ffffffff'})
   self.assertTrue(entered.wait(1))
   for x in range(1,100):send({'x':x,'y':0})
   wait(lambda:reader.snapshot()[1]['x']==99)
   self.assertNotIn('image',reader.snapshot()[1])
   # Supersede that slow shape several times. Only the final pending shape
   # may be published, and it must retain all more recent position updates.
   for x in range(100,120):send({'x':x,'y':0,'visible':True,'hx':0,'hy':0,'w':2,'h':1,'rgba':'000000ff'*2})
   send({'x':300,'y':0});wait(lambda:reader.snapshot()[1]['x']==300)
   release.set();wait(lambda:'image' in reader.snapshot()[1])
   state=reader.snapshot()[1];self.assertEqual(state['x'],300);self.assertEqual(state['w'],2);self.assertEqual(decoded,[1,2])
  finally:
   release.set();reader.stopping.set();lines.put(b'');read.join(1);shapes.join(1)
  self.assertFalse(read.is_alive());self.assertFalse(shapes.is_alive())

class ThemeTests(unittest.TestCase):
 def fixture(self, high_size=4):
  low=bytes([80,40,20,255])*4
  high=bytes([90,45,22,255])*(high_size*high_size)
  chunks=[]
  for size,pixels in [(2,low),(high_size,high)]:
   bgra=bytearray(pixels);bgra[0::4],bgra[2::4]=pixels[2::4],pixels[0::4]
   chunks.append(struct.pack('<9I',36,0xfffd0002,size,1,size,size,1,1,0)+bgra)
  head=struct.pack('<4I',0x72756358,16,1,2);offset=40
  for size,chunk in zip([2,high_size],chunks):head+=struct.pack('<3I',0xfffd0002,size,offset);offset+=len(chunk)
  return head+b''.join(chunks),low,high
 def test_exact_theme_frame_uses_higher_resolution_without_guessing_custom_cursor(self):
  data,low,high=self.fixture()
  with tempfile.TemporaryDirectory() as root:
   folder=pathlib.Path(root);(folder/'arrow').write_bytes(data)
   theme=CursorTheme([folder])
   self.assertEqual(theme.resolve(2,2,low),(4,4,1,1,high))
   self.assertIsNone(theme.resolve(2,2,bytes([0,0,0,0])*4))
 def test_high_density_theme_keeps_its_largest_native_frame(self):
  data,low,high=self.fixture(128)
  with tempfile.TemporaryDirectory() as root:
   folder=pathlib.Path(root);(folder/'arrow').write_bytes(data)
   theme=CursorTheme([folder])
   self.assertEqual(theme.resolve(2,2,low),(128,128,1,1,high))
 def test_truncated_theme_cannot_supply_partial_pixels(self):
  data,_,_=self.fixture()
  self.assertEqual(frames(b''),[])
  self.assertEqual(len(frames(data[:-1])),1)
  self.assertEqual(frames(b'bad!'+data[4:]),[])

if __name__=='__main__':unittest.main()
