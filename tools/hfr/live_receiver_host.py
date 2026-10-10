"""Own and close the local test receiver and temporary animation window."""
import pathlib,subprocess
here=pathlib.Path(__file__).resolve().parent
children=[]
try:
    proxy=subprocess.Popen(['/usr/bin/python3',str(here/'local_proxy_check.py')]);children.append(proxy)
    scene=subprocess.Popen(['/usr/bin/python3',str(here/'scene.py')]);children.append(scene)
    if proxy.wait(timeout=85):raise SystemExit('Local receiver failed')
finally:
    for child in children:
        if child.poll() is None:child.terminate()
    for child in children:
        try:child.wait(timeout=2)
        except subprocess.TimeoutExpired:child.kill();child.wait()
