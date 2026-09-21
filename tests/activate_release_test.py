"""Rollback checks use temporary files and a fake service manager, never user services."""
import hashlib,json,os,runpy,socket,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
SCRIPT=Path(__file__).resolve().parents[1]/'setup/activate-release.py'
class ActivationTests(unittest.TestCase):
 def scenario(self, fail=False):
  with tempfile.TemporaryDirectory() as directory:
   home=Path(directory);release=home/'release';release.mkdir();(release/'gateway').mkdir();binary=release/'gateway/phonepad';binary.write_bytes(b'candidate')
   (release/'manifest.json').write_text(json.dumps({'commit':'fixture','checks':'passed','files':{'gateway/phonepad':hashlib.sha256(binary.read_bytes()).hexdigest()}}))
   override=home/'.config/systemd/user/phonepad.service.d/90-phonepad-release.conf';override.parent.mkdir(parents=True);override.write_text('previous override')
   runtime=home/'runtime/phonepad-preview';runtime.mkdir(parents=True);sock=socket.socket(socket.AF_UNIX);sock.bind(str(runtime/'capture.sock'))
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
      with patch.object(sys,'argv',args+['--rollback']),self.assertRaises(SystemExit):runpy.run_path(str(SCRIPT),run_name='__main__')
    self.assertEqual(override.read_text(),'previous override')
    self.assertFalse((home/'.config/systemd/user/phonepad-preview.service.d/90-phonepad-release.conf').exists())
   finally:sock.close()
 def test_explicit_rollback_restores_previous_overrides(self):self.scenario()
 def test_failed_activation_restores_previous_overrides(self):self.scenario(True)
if __name__=='__main__':unittest.main()
