#!/usr/bin/python3
"""Bounded local health history. Never records argv, environment or file contents."""
import datetime,json,os,time
from pathlib import Path
os.umask(0o077)
root=Path.home()/'.local/state/phonepad-health';root.mkdir(parents=True,exist_ok=True)
def read(p):
 try:return Path(p).read_text()
 except (OSError,ValueError):return ''
mem={}
for line in read('/proc/meminfo').splitlines():
 k,v=line.split(':',1)
 if k in ('MemTotal','MemAvailable','SwapTotal','SwapFree','SwapCached','Dirty'):mem[k]=int(v.split()[0])
processes=[]
for p in Path('/proc').glob('[0-9]*'):
 try:
  if p.stat().st_uid!=os.getuid():continue
  fields=(p/'statm').read_text().split();rss=int(fields[1])*os.sysconf('SC_PAGE_SIZE')//1024
  processes.append({'pid':int(p.name),'name':(p/'comm').read_text().strip(),'rssKiB':rss})
 except (OSError,ValueError,IndexError):pass
power={}
for device in Path('/sys/class/power_supply').glob('*'):
 values={name:read(device/name).strip() for name in ('type','status','online','capacity','voltage_now','current_now','power_now')}
 power[device.name]={k:v for k,v in values.items() if v}
thermal=[]
for zone in Path('/sys/class/thermal').glob('thermal_zone*'):
 value=read(zone/'temp').strip()
 if value:
  try:thermal.append({'type':read(zone/'type').strip(),'celsius':int(value)/1000})
  except ValueError:pass
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bootId':read('/proc/sys/kernel/random/boot_id').strip(),'uptime':read('/proc/uptime').split()[:1],'power':power,'thermal':thermal,'memoryKiB':mem,'pressure':read('/proc/pressure/memory').strip(),'load':read('/proc/loadavg').split()[:3],'topRSS':sorted(processes,key=lambda v:v['rssKiB'],reverse=True)[:12]}
path=root/(datetime.date.today().isoformat()+'.jsonl')
# Bound both individual file growth and retention, even if invoked too often.
if not path.exists() or path.stat().st_size<5*1024*1024:
 with path.open('a') as f:f.write(json.dumps(record)+'\n')
for p in root.glob('*.jsonl'):
 if p.stat().st_mtime<time.time()-14*86400:p.unlink()
