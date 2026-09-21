#!/usr/bin/env python3
"""Activate a checksummed local release with systemd overrides and reversible rollback."""
import argparse,hashlib,json,os,shutil,subprocess,time,urllib.request,urllib.error
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('--rollback',action='store_true');p.add_argument('--health-host',required=True);a=p.parse_args()
r=a.release.resolve();backup=r/'rollback';units=('phonepad.service','phonepad-preview.service');root=Path.home()/'.config/systemd/user'
paths=[root/(u+'.d')/'90-phonepad-release.conf' for u in units]
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=40).stdout

def restore():
 state=json.loads((backup/'state.json').read_text())
 for path,item in zip(paths,state['overrides']):
  if item['existed']:shutil.copyfile(backup/item['file'],path)
  else:path.unlink(missing_ok=True)
 run('systemctl','--user','daemon-reload')
 for unit,active in zip(units,state['active']):
  run('systemctl','--user','restart' if active else 'stop',unit)

if a.rollback:
 restore();print('Rollback restored');raise SystemExit
manifest=json.loads((r/'manifest.json').read_text())
if manifest.get('checks')!='passed':raise SystemExit('Release checks are not passed')
for name,digest in manifest['files'].items():
 path=(r/name).resolve()
 if not path.is_relative_to(r) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise SystemExit('Checksum mismatch: '+name)
if backup.exists():raise SystemExit('Backup already exists; use a new release or rollback explicitly')
backup.mkdir(mode=0o700)
state={'active':[],'overrides':[]}
for i,(unit,path) in enumerate(zip(units,paths)):
 active=subprocess.run(['systemctl','--user','is-active','--quiet',unit]).returncode==0
 state['active'].append(active);state['overrides'].append({'existed':path.exists(),'file':str(i)+'.conf'})
 if path.exists():shutil.copy2(path,backup/(str(i)+'.conf'))
 (backup/(unit+'.before.txt')).write_text(run('systemctl','--user','cat',unit))
(backup/'state.json').write_text(json.dumps(state,indent=2)+'\n')
# Keep the existing binary, video tree, service definitions, keys and pairing data intact.
command='"'+str(r/'gateway/phonepad').replace('%','%%')+'" --bind=${PHONEPAD_BIND} --advertise-host=${PHONEPAD_HOST} --tls-cert=${PHONEPAD_TLS_CERT} --tls-key=${PHONEPAD_TLS_KEY} --gateway-port=${PHONEPAD_GATEWAY_PORT} --public-url=${PHONEPAD_PUBLIC_URL}'
contents=['[Service]\nExecStart=\nExecStart='+command+'\n','[Service]\nExecStart=\nExecStart=/usr/bin/python3 "'+str(r/'server/capture.py').replace('%','%%')+'"\n']
try:
 for path,content in zip(paths,contents):
  path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix('.new');tmp.write_text(content);os.replace(tmp,path)
 run('systemctl','--user','daemon-reload')
 run('systemctl','--user','restart','phonepad-preview.service','phonepad.service')
 for _ in range(40):
  try:
   req=urllib.request.Request('http://127.0.0.1:8081/api/auth',headers={'Host':a.health_host})
   try: response=urllib.request.urlopen(req,timeout=2);code=response.status
   except urllib.error.HTTPError as e:code=e.code
   if code==401:break
  except OSError:pass
  time.sleep(.25)
 else:raise RuntimeError('Gateway authorization health check failed')
 for unit in units:run('systemctl','--user','is-active','--quiet',unit)
 # Socket existence checks startup without asking the portal to capture a screen.
 sock=Path(os.environ.get('XDG_RUNTIME_DIR','/run/user/'+str(os.getuid())))/'phonepad-preview/capture.sock'
 if not sock.is_socket():raise RuntimeError('Preview socket missing')
except BaseException:
 restore();raise
(r/'activation.json').write_text(json.dumps({'commit':manifest['commit'],'services':'active','authStatus':401,'physicalAcceptance':False,'rollback':str(backup)},indent=2)+'\n')
print('Release activated; original installation retained for rollback')
