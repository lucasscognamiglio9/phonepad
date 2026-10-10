"""Rollback checks use temporary files and a fake service manager, never user services."""
import hashlib,json,os,runpy,socket,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
SCRIPT=Path(__file__).resolve().parents[1]/'setup/activate-release.py'
class ActivationTests(unittest.TestCase):
 def scenario(self, fail=False, controller=None):
  with tempfile.TemporaryDirectory() as directory:
   home=Path(directory);release=home/'release';release.mkdir();(release/'gateway').mkdir();binary=release/'gateway/phonepad';binary.write_bytes(b'candidate')
   (release/'manifest.json').write_text(json.dumps({'commit':'fixture','checks':'passed','files':{'gateway/phonepad':hashlib.sha256(binary.read_bytes()).hexdigest()}}))
   override=home/'.config/systemd/user/phonepad.service.d/90-phonepad-release.conf';override.parent.mkdir(parents=True);override.write_text('previous override')
   runtime=home/'runtime/phonepad-preview';runtime.mkdir(parents=True);sock=socket.socket(socket.AF_UNIX);sock.bind(str(runtime/'capture.sock'))
   if controller:
    value=json.loads((release/'manifest.json').read_text());value['rtcController']=controller
    if controller=='gcc':value['videoAdmission']={'desktopRegression':{'passed':True}}
    (release/'manifest.json').write_text(json.dumps(value))
   commands=[]
   def run(args,**kwargs):
    commands.append(args)
    if fail and list(args[-2:])==['phonepad-preview.service','phonepad.service']:raise subprocess.CalledProcessError(1,args)
    return subprocess.CompletedProcess(args,0,stdout='previous service definitions')
   import urllib.error
   error=urllib.error.HTTPError('http://fixture',401,'unauthorized',{},None)
   args=['activate-release.py',str(release),'--health-host','fixture']
   try:
    with patch.object(Path,'home',return_value=home),patch.dict(os.environ,{'XDG_RUNTIME_DIR':str(runtime.parent)}),patch('subprocess.run',side_effect=run),patch('urllib.request.urlopen',side_effect=error),patch.object(sys,'argv',args):
     if fail:
      with self.assertRaises(subprocess.CalledProcessError):runpy.run_path(str(SCRIPT),run_name='__main__')
     else:
      runpy.run_path(str(SCRIPT),run_name='__main__');self.assertTrue((release/'activation.json').exists())
      self.assertIn(str(binary),override.read_text())
      if controller:self.assertIn('/usr/bin/env PHONEPAD_RTC_CONTROLLER='+controller,(home/'.config/systemd/user/phonepad-preview.service.d/90-phonepad-release.conf').read_text())
      with patch.object(sys,'argv',args+['--rollback']),self.assertRaises(SystemExit):runpy.run_path(str(SCRIPT),run_name='__main__')
    self.assertEqual(override.read_text(),'previous override')
    self.assertFalse((home/'.config/systemd/user/phonepad-preview.service.d/90-phonepad-release.conf').exists())
   finally:error.close();sock.close()
 def test_explicit_rollback_restores_previous_overrides(self):self.scenario()
 def test_gcc_selection_is_explicit_and_rollback_restores_previous_overrides(self):self.scenario(controller='gcc')
 def test_failed_activation_restores_previous_overrides(self):self.scenario(True)
 def test_release_path_cannot_inject_systemd_directives(self):
  with tempfile.TemporaryDirectory() as directory:
   for suffix in ('\nExecStart=/bin/false','"unsafe','\\unsafe'):
    with self.subTest(suffix=suffix),patch('subprocess.run') as commands,patch.object(sys,'argv',['activate-release.py',directory+suffix,'--health-host','fixture']):
     with self.assertRaisesRegex(SystemExit,'unsafe for a systemd'):runpy.run_path(str(SCRIPT),run_name='__main__')
     commands.assert_not_called()
 def test_gcc_without_quality_admission_cannot_modify_services(self):
  for admission in ({}, {'videoAdmission': {'desktopRegression': {'passed': False}}}):
   with self.subTest(admission=admission),tempfile.TemporaryDirectory() as directory:
    home=Path(directory);release=home/'release';release.mkdir()
    (release/'manifest.json').write_text(json.dumps({'commit':'fixture','checks':'passed','rtcController':'gcc','files':{},**admission}))
    with patch.object(Path,'home',return_value=home),patch('subprocess.run') as commands,patch.object(sys,'argv',['activate-release.py',str(release),'--health-host','fixture']):
     with self.assertRaisesRegex(SystemExit,'desktop regression gate'):runpy.run_path(str(SCRIPT),run_name='__main__')
    commands.assert_not_called();self.assertFalse((release/'rollback').exists())
if __name__=='__main__':unittest.main()
