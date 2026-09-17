"""Exercise impairments on disposable veth links, never on a host interface.

Requires Linux unshare/ip/nsenter/tc. No sudo, saved credentials or live peers.
Results are smoke tests of the laboratory, not PhonePad transport benchmarks.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

PROFILES = {
    'clean': [[]],
    'loss': [['loss', '3%', 'seed', '42']],
    'jitter': [['delay', '20ms', '10ms', 'distribution', 'normal', 'seed', '42']],
    'capacity': [['rate', '8mbit', 'limit', '64']],
    'recovery': [['loss', '10%', 'seed', '42'], []],
    'rtt_step': [['delay', '10ms'], ['delay', '100ms']],
    'udp_blocked': [[]],
    'route_change': [[], []],
}


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=10)


def receiver(directory):
    directory = Path(directory)
    (directory / 'ready').touch()
    deadline = time.monotonic() + 15
    while not (directory / 'start').exists():
        if time.monotonic() > deadline:
            raise TimeoutError('No network configuration received')
        time.sleep(.02)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind(('198.18.0.2', 39831))
        server.settimeout(1)
        (directory / 'listening').touch()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                data, source = server.recvfrom(2048)
                server.sendto(data, source)
            except socket.timeout:
                pass


def wait_for(path, process):
    deadline = time.monotonic() + 10
    while not path.exists():
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Receiver failed to start')
        time.sleep(.02)


def inside(parent_net, out, profile):
    current = os.readlink('/proc/self/ns/net')
    if current in (parent_net, os.readlink('/proc/1/ns/net')):
        raise RuntimeError('Refusing network changes without a private namespace')
    report = {'schema_version': 1, 'kind': 'isolated-network-lab-smoke',
              'scope': 'UDP echo between private namespaces; no PhonePad session or Internet',
              'private_network_verified': True, 'profiles': []}
    with tempfile.TemporaryDirectory(prefix='phonepad-net-') as folder:
        directory = Path(folder)
        process = subprocess.Popen(['unshare', '--net', sys.executable, __file__, '--receiver', folder],
                                   start_new_session=True)
        try:
            wait_for(directory / 'ready', process)
            def peer(*args):
                return run('nsenter', '-t', str(process.pid), '-n', *args)
            run('ip', 'link', 'set', 'lo', 'up')
            peer('ip', 'link', 'set', 'lo', 'up')
            run('ip', 'addr', 'add', '198.18.0.1/32', 'dev', 'lo')
            peer('ip', 'addr', 'add', '198.18.0.2/32', 'dev', 'lo')
            for index in (1, 2):
                a, b = f'pp-a{index}', f'pp-b{index}'
                run('ip', 'link', 'add', a, 'type', 'veth', 'peer', 'name', b)
                run('ip', 'link', 'set', b, 'netns', str(process.pid))
                run('ip', 'addr', 'add', f'192.0.{index}.1/30', 'dev', a)
                peer('ip', 'addr', 'add', f'192.0.{index}.2/30', 'dev', b)
                run('ip', 'link', 'set', a, 'up')
                peer('ip', 'link', 'set', b, 'up')
            def route(index):
                run('ip', 'route', 'replace', '198.18.0.2/32', 'via', f'192.0.{index}.2', 'dev', f'pp-a{index}')
                peer('ip', 'route', 'replace', '198.18.0.1/32', 'via', f'192.0.{index}.1', 'dev', f'pp-b{index}')
            route(1)
            (directory / 'start').touch()
            wait_for(directory / 'listening', process)
            for name in PROFILES if profile == 'all' else [profile]:
                route(1)
                run('tc', 'qdisc', 'del', 'dev', 'pp-a1', 'clsact', check=False)
                result = {'name': name, 'stages': []}
                for stage_index, settings in enumerate(PROFILES[name]):
                    # netem replace can retain omitted settings from the prior
                    # profile. Start with a fresh qdisc for every stage.
                    run('tc', 'qdisc', 'del', 'dev', 'pp-a1', 'root', check=False)
                    run('tc', 'qdisc', 'add', 'dev', 'pp-a1', 'root', 'netem', *settings)
                    qdisc = run('tc', 'qdisc', 'show', 'dev', 'pp-a1').stdout
                    for option in ('delay', 'loss', 'rate'):
                        if (option in settings) != (f' {option} ' in qdisc):
                            raise RuntimeError(f'Unexpected netem {option}: {qdisc}')
                    if name == 'udp_blocked':
                        run('tc', 'qdisc', 'add', 'dev', 'pp-a1', 'clsact')
                        run('tc', 'filter', 'add', 'dev', 'pp-a1', 'egress', 'protocol', 'ip',
                            'flower', 'ip_proto', 'udp', 'action', 'drop')
                    if name == 'route_change' and stage_index == 1:
                        route(2)
                    samples = []
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                        client.bind(('198.18.0.1', 0))
                        client.settimeout(.4)
                        for seq in range(64 if name in ('loss', 'recovery') else 12):
                            payload = f'{name}:{stage_index}:{seq}'.encode().ljust(1200, b'.')
                            started = time.monotonic()
                            client.sendto(payload, ('198.18.0.2', 39831))
                            try:
                                # Ignore a delayed echo belonging to a previous probe.
                                while True:
                                    remaining = .4 - (time.monotonic() - started)
                                    if remaining <= 0: raise socket.timeout()
                                    client.settimeout(remaining)
                                    data, _ = client.recvfrom(2048)
                                    if data == payload: break
                                samples.append(round((time.monotonic() - started) * 1000, 3))
                            except socket.timeout:
                                samples.append(None)
                    result['stages'].append({'netem': settings, 'rtt_ms': samples,
                                             'route': run('ip', 'route', 'get', '198.18.0.2', 'from', '198.18.0.1').stdout.strip(),
                                             'qdisc': run('tc', '-s', 'qdisc', 'show', 'dev', 'pp-a1').stdout.strip()})
                if name == 'udp_blocked':
                    assert all(value is None for value in result['stages'][0]['rtt_ms']), 'UDP was not blocked'
                else:
                    assert all(any(value is not None for value in stage['rtt_ms']) for stage in result['stages']), 'No successful probes'
                report['profiles'].append(result)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'evidence': str(out), 'profiles': len(report['profiles']), 'private_network_verified': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--profile', choices=['all', *PROFILES], default='all')
    parser.add_argument('--parent-net', help=argparse.SUPPRESS)
    parser.add_argument('--receiver', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.receiver:
        receiver(args.receiver)
    elif args.out is None:
        parser.error('--out is required')
    elif args.parent_net:
        inside(args.parent_net, args.out, args.profile)
    else:
        subprocess.run(['unshare', '--user', '--map-root-user', '--net', sys.executable, __file__,
                        '--parent-net', os.readlink('/proc/self/ns/net'), '--profile', args.profile,
                        '--out', str(args.out.resolve())], check=True, timeout=120)


if __name__ == '__main__':
    main()
