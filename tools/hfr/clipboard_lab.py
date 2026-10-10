"""Exercise the real GTK multi-file provider on the private input laboratory."""
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from gi.repository import Gdk, GLib


def verify(root, repo, finished):
    script = re.search(r'const gtkClipboardScript = `(.*?)`', (repo/'daemon/internal/server/clipboard.go').read_text(), re.S).group(1)
    paths = [root/'first #.png', root/'second ñ.png']
    for index, path in enumerate(paths): path.write_bytes(b'fixture-'+bytes([index]))
    expected = {
        'text/uri-list': '\r\n'.join(p.as_uri() for p in paths)+'\r\n',
        'x-special/gnome-copied-files': 'copy\n'+'\n'.join(p.as_uri() for p in paths)+'\n',
        'application/x-kde4-urilist': '\n'.join(p.as_uri() for p in paths)+'\n',
    }
    # Include a second request of the same MIME after > 40 ms.
    requests = list(expected) + ['text/uri-list']
    results = []
    clipboard = Gdk.Display.get_default().get_clipboard()
    log = (root/'clipboard-helper.log').open('w')
    provider_env = os.environ.copy()
    display = re.search(r'Using public X11 display (:[0-9]+),', (root/'shell.log').read_text()).group(1)
    authority = next((root/'run').glob('.mutter-Xwaylandauth.*'))
    provider_env.update(DISPLAY=display, XAUTHORITY=str(authority), GDK_BACKEND='x11')
    provider = subprocess.Popen(['/usr/bin/python3', '-c', script, json.dumps([str(p) for p in paths]), 'files'], stdout=subprocess.PIPE, stderr=log, text=True, env=provider_env)
    def conclude(owner_released=False):
        report = {'scope':'private GTK clipboard, synthetic files only', 'requests':results, 'ownerReleased':owner_released}
        (root/'clipboard-result.json').write_text(json.dumps(report, indent=2))
        if provider.poll() is None: provider.kill()
        provider.wait(timeout=3); log.close()
        finished(bool(len(results)==4 and all(r['exact'] for r in results) and owner_released))
        return False
    def read_next():
        index = len(results)
        if index == len(requests):
            clipboard.set_content(Gdk.ContentProvider.new_for_bytes('text/plain', GLib.Bytes.new(b'new synthetic user copy')))
            GLib.timeout_add(1000, lambda: conclude(provider.poll() is not None))
            return False
        mime = requests[index]
        def received(clipboard, result):
            try:
                stream, offered = clipboard.read_finish(result)
                data = bytearray()
                while True:
                    block = stream.read_bytes(4096, None).get_data()
                    if not block: break
                    data.extend(block)
                    if len(data)>16384: raise ValueError('unbounded fixture')
                stream.close(None)
                exact = offered==mime and data.decode()==expected[mime]
            except Exception as error:
                (root/'clipboard-read-errors.log').open('a').write(str(error)+'\n')
                exact = False
            results.append({'mime':mime, 'exact':exact, 'delayBeforeReadMs':1250 if index==0 else 300})
            GLib.timeout_add(300, read_next)
        clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, None, received)
        return False
    def wait_ready():
        ready = provider.stdout.readline().strip() == 'ready'
        if ready: GLib.timeout_add(1250, read_next)
        else: GLib.idle_add(conclude)
    threading.Thread(target=wait_ready,daemon=True).start()
