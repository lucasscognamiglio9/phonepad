"""Run only an isolated, bounded HFR capture experiment, never the live desktop.

Launch in a systemd user unit with MemoryMax, RuntimeMaxSec and KillMode=control-group.
No saved portal tokens, live monitor changes or user files. The optional
WebRTC test listens only on loopback for its local synthetic receiver.
"""
import json, os, pathlib, subprocess, tempfile, time, threading

root = pathlib.Path(tempfile.mkdtemp(prefix='phonepad-hfr-'))
root.chmod(0o700)
env = os.environ.copy()
for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_ID'):
    env.pop(key, None)
for name, folder in [('HOME', 'home'), ('XDG_RUNTIME_DIR', 'run'), ('XDG_CONFIG_HOME', 'config'),
                     ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache')]:
    directory = root / folder; directory.mkdir(mode=0o700); env[name] = str(directory)
env.update(GSETTINGS_BACKEND='memory', GTK_A11Y='none', NO_AT_BRIDGE='1',
           PHONEPAD_HFR_ROOT=str(root), WAYLAND_DISPLAY='phonepad-lab')
env['DEBUGINFOD_URLS'] = ''
if os.environ.get('PHONEPAD_LAB_INPUT') == '1':
    env['GTK_A11Y'] = 'atspi'
    env.pop('NO_AT_BRIDGE', None)
if os.environ.get('PHONEPAD_LAB_SCALE', '1') != '1':
    schemas = root / 'schemas'; schemas.mkdir()
    for schema in pathlib.Path('/usr/share/glib-2.0/schemas').glob('*.xml'):
        (schemas / schema.name).symlink_to(schema)
    (schemas / '99-phonepad-lab.gschema.override').write_text(
        "[org.gnome.mutter]\nexperimental-features=['scale-monitor-framebuffer', 'xwayland-native-scaling']\n")
    subprocess.run(['glib-compile-schemas', '--strict', str(schemas)], check=True, capture_output=True)
    env['GSETTINGS_SCHEMA_DIR'] = str(schemas)
# Do not enable service activation: a test compositor needs neither accounts,
# keyrings, portal documents, input methods nor a second set of user services.
config = root / 'bus.conf'
config.write_text('<busconfig><type>session</type><listen>unix:tmpdir=' + str(root) +
                 '</listen><policy context="default"><allow send_destination="*"/>'
                 '<allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
children = []
logs = []
resources=[]
stop_sampling=threading.Event()
def sample_resources():
    group=next((x.split(':',2)[2] for x in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if x.startswith('0::')),None)
    if not group:return
    directory=pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')
    while not stop_sampling.is_set():
        try:
            cpu=dict(line.split() for line in (directory/'cpu.stat').read_text().splitlines())
            resources.append({'time':time.monotonic(),'cpu':{k:int(v) for k,v in cpu.items()},'memoryBytes':int((directory/'memory.current').read_text())})
        except OSError:pass
        stop_sampling.wait(1)
threading.Thread(target=sample_resources,daemon=True).start()
def start(args, name, stdout=None):
    log = (root / (name + '.log')).open('w'); logs.append(log)
    process = subprocess.Popen(args, env=env, stdout=stdout or log, stderr=log)
    children.append(process); return process
try:
    bus = start(['dbus-daemon', '--nofork', '--config-file=' + str(config), '--print-address=1'], 'bus', subprocess.PIPE)
    env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().decode().strip()
    if not env['DBUS_SESSION_BUS_ADDRESS'].startswith('unix:path=' + str(root)):
        raise RuntimeError('Private bus verification failed')
    if os.environ.get('PHONEPAD_LAB_INPUT') == '1':
        start(['/usr/libexec/at-spi-bus-launcher', '--launch-immediately'], 'accessibility')
    start(['pipewire'], 'pipewire')
    start(['wireplumber', '--profile=policy'], 'wireplumber')
    shell_args = ['gnome-shell', '--headless', '--no-x11', '--wayland-display=phonepad-lab',
                  '--virtual-monitor=1920x1080@' + os.environ.get('PHONEPAD_LAB_HZ', '120')]
    if os.environ.get('PHONEPAD_LAB_CLIPBOARD') == '1':
        shell_args.remove('--no-x11')
    if os.environ.get('PHONEPAD_LAB_DEBUG') == '1':
        shell_args = ['gdb', '--batch', '-ex', 'run', '-ex', 'bt 20', '--args'] + shell_args
    shell = start(shell_args, 'shell')
    for _ in range(150):
        if shell.poll() is not None: raise RuntimeError('Isolated compositor failed; inspect shell.log')
        if (root / 'run/phonepad-lab').exists() and (root / 'run/pipewire-0').exists(): break
        time.sleep(.1)
    else: raise RuntimeError('Isolated compositor timeout')
    # The Wayland socket appears before GNOME finishes its D-Bus startup.
    # Probe the private display service instead of timing the capture against
    # an arbitrary sleep while the compositor is still registering itself.
    ready_begin = time.monotonic()
    attempts = 0
    while time.monotonic() - ready_begin < 30:
        attempts += 1
        try:
            ready = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.gnome.Mutter.DisplayConfig',
                                    '--object-path', '/org/gnome/Mutter/DisplayConfig', '--method',
                                    'org.gnome.Mutter.DisplayConfig.GetCurrentState'],
                                   env=env, capture_output=True, timeout=1)
            if ready.returncode == 0: break
        except subprocess.TimeoutExpired:
            pass
        if shell.poll() is not None: raise RuntimeError('Isolated compositor exited before readiness')
        time.sleep(.2)
    else: raise RuntimeError('Isolated display service timeout')
    (root / 'readiness.json').write_text(json.dumps({'attempts': attempts, 'seconds': time.monotonic() - ready_begin}))
    here = pathlib.Path(__file__).parent
    if os.environ.get('PHONEPAD_LAB_SCALE', '1') != '1':
        configure = start(['/usr/bin/python3', str(here / 'initial_layout.py')], 'initial-layout')
        if configure.wait(timeout=10): raise RuntimeError('Lab scale configuration failed')
    if os.environ.get('PHONEPAD_LAB_INPUT') == '1':
        editor = start(['/usr/bin/python3', str(here / 'input_lab.py')], 'input')
        if editor.wait(timeout=35): raise RuntimeError('Input fixture failed; inspect input-result.json')
        print((root / 'input-result.json').read_text(), flush=True)
        raise SystemExit(0)
    start(['/usr/bin/python3', str(here / 'scene.py')], 'scene')
    time.sleep(3)
    print('Lab started: ' + str(root), flush=True)
    # Only this worker loads the optional GPU runtime, keeping GTK/GNOME on
    # the system libraries. The worker refuses a primary-session bus.
    cycles = int(os.environ.get('PHONEPAD_LAB_CYCLES', '1'))
    if not 1 <= cycles <= 10: raise ValueError('Invalid cycle count')
    if os.environ.get('PHONEPAD_LAB_RATE_AB') == '1': cycles = 2
    for cycle in range(cycles):
        if os.environ.get('PHONEPAD_LAB_RATE_AB') == '1':
            env['PHONEPAD_RATE_POLICY'] = ('legacy', 'windowed')[cycle]
        experiment = here / ('webrtc_lab.py' if os.environ.get('PHONEPAD_LAB_WEBRTC') == '1' else 'measure.py')
        if os.environ.get('PHONEPAD_LAB_MEDIA') == '1':
            experiment = here.parent / 'refactor/p02_media_lab.py'
        if os.environ.get('PHONEPAD_LAB_GCC') == '1':
            experiment = here.parent / 'refactor/p03_gcc_media_lab.py'
        worker = start(['/usr/bin/python3', str(here / 'runtime.py'), str(experiment)], 'measure-' + str(cycle))
        if os.environ.get('PHONEPAD_LAB_FAULT') == '1':
            time.sleep(8)
            if worker.poll() is not None: raise RuntimeError('Worker exited before fault injection')
            worker.kill(); worker.wait(timeout=5)
            time.sleep(2)
            if shell.poll() is not None: raise RuntimeError('Compositor crashed after capture worker death')
            inspector = start(['/usr/bin/python3', str(here / 'fault_state.py')], 'fault-' + str(cycle))
            result = inspector.wait(timeout=10)
        else:
            result = worker.wait(timeout=int(os.environ.get('PHONEPAD_LAB_SECONDS', '15')) + 20)
        if result: raise RuntimeError('Measurement exited ' + str(result) + '; inspect measure log')
        if shell.poll() is not None: raise RuntimeError('Isolated compositor exited unexpectedly')
        destination = root / ('cycle-' + str(cycle)); destination.mkdir()
        for name in ('result.json', 'motion.h264'):
            (root / name).rename(destination / name)
        print((destination / 'result.json').read_text(), flush=True)

finally:
    stop_sampling.set()
    (root/'resources.json').write_text(json.dumps(resources,indent=2))
    for process in reversed(children):
        if process.poll() is None: process.terminate()
    for process in reversed(children):
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    for log in logs: log.close()
    print('Lab evidence: ' + str(root), flush=True)
