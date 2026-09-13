import os,pathlib,sys,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup/preview'))
from process_backend import ProcessBackend
FAKE='''import sys,json
for line in sys.stdin:
 d=json.loads(line)
 if d['op']=='crash':sys.exit(1)
 if d['op']=='start':r={'id':'test-session','sdp':'test'}
 elif d.get('id')!='test-session':
  print(json.dumps({'error':'session unavailable','invalid':True}),flush=True);continue
 else:r={'ok':True}
 print(json.dumps({'result':r}),flush=True)
 if d['op']=='stop':break
'''
class ProcessTests(unittest.TestCase):
 def setUp(self):self.backend=ProcessBackend([sys.executable,'-u','-c',FAKE])
 def tearDown(self):self.backend.close()
 def test_session_restart_reaps_previous_process(self):
  for _ in range(5):
   self.backend.handle({'op':'start'})
   proc=self.backend.process
   self.assertTrue(self.backend.handle({'op':'suspend','id':'test-session'})['ok'])
   self.assertTrue(self.backend.handle({'op':'resume','id':'test-session'})['ok'])
   self.backend.handle({'op':'stop','id':'test-session'})
   self.assertIsNone(self.backend.process);self.assertEqual(proc.poll(),0)
 def test_bad_session_does_not_close_good_session(self):
  self.backend.handle({'op':'start'})
  with self.assertRaises(ValueError):self.backend.handle({'op':'resume','id':'wrong'})
  self.assertIsNotNone(self.backend.session)
 def test_worker_death_releases_pipes(self):
  self.backend.handle({'op':'start'});proc=self.backend.process;proc.kill();proc.wait()
  # Unavailable session also reaps pipes, without waiting for another start.
  with self.assertRaises(ValueError):self.backend.handle({'op':'resume','id':'test-session'})
  self.assertIsNone(self.backend.process)
  self.assertTrue(proc.stdout.closed);self.assertTrue(proc.stdin.closed)
 def test_invalid_codec_does_not_start_worker(self):
  with self.assertRaises(ValueError):self.backend.handle({'op':'start','codec':'H265'})
  self.assertIsNone(self.backend.process)
 def test_invalid_start_preserves_running_session(self):
  self.backend.handle({'op':'start'});proc=self.backend.process
  for request in ({'op':'start','width':99999},{'op':'start','width':True},{'op':'start','extra':'x'*65536}):
   with self.assertRaises(ValueError):self.backend.handle(request)
   self.assertIs(self.backend.process,proc);self.assertIsNone(proc.poll())
 def test_worker_start_error_reaps_child(self):
  self.backend.close()
  self.backend=ProcessBackend([sys.executable,'-u','-c',"import json;input();print(json.dumps({'error':'source unavailable','invalid':True}),flush=True)"])
  with self.assertRaises(ValueError):self.backend.handle({'op':'start'})
  self.assertIsNone(self.backend.process)
 def test_fresh_portal_fd_is_inherited_and_parent_copy_closed(self):
  granted=[]
  def grant():
   reader,writer=os.pipe()
   os.write(writer,b'C');os.close(writer)
   granted.append(reader)
   return reader,123
  code=FAKE.replace('import sys,json','import sys,json,os').replace(
   "r={'id':'test-session','sdp':'test'}",
   "r={'id':'test-session','sdp':os.read(int(os.environ['PHONEPAD_CURSOR_FD']),1).decode(),'node':os.environ['PHONEPAD_CURSOR_NODE']}")
  self.backend=ProcessBackend([sys.executable,'-u','-c',code],cursor_grant=grant)
  for _ in range(3):
   result=self.backend.handle({'op':'start'})
   self.assertEqual(result['sdp'],'C');self.assertEqual(result['node'],'123')
   with self.assertRaises(OSError):os.fstat(granted[-1])
  self.assertEqual(len(granted),3)
 def test_failed_spawn_closes_portal_fd(self):
  reader,writer=os.pipe();os.close(writer)
  self.backend=ProcessBackend(['/missing/phonepad-worker'],cursor_grant=lambda:(reader,123))
  with self.assertRaises(FileNotFoundError):self.backend.handle({'op':'start'})
  with self.assertRaises(OSError):os.fstat(reader)
  self.assertIsNone(self.backend.process)
 def test_invalid_start_does_not_obtain_portal_grant(self):
  grant=Mock()
  self.backend=ProcessBackend(cursor_grant=grant)
  with self.assertRaises(ValueError):self.backend.handle({'op':'start','width':True})
  grant.assert_not_called()
 def test_no_grant_does_not_inherit_stale_fd_environment(self):
  code=FAKE.replace('import sys,json',"import sys,json,os;assert 'PHONEPAD_CURSOR_FD' not in os.environ;assert 'PHONEPAD_CURSOR_NODE' not in os.environ")
  self.backend=ProcessBackend([sys.executable,'-u','-c',code])
  with patch.dict(os.environ,{'PHONEPAD_CURSOR_FD':'99','PHONEPAD_CURSOR_NODE':'1'}):
   self.assertEqual(self.backend.handle({'op':'start'})['id'],'test-session')
if __name__=='__main__':unittest.main()
