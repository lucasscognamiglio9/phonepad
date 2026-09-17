"""Preserve local rollback artifacts; never restart a service or read clipboard."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import zipfile


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('origin', 'server', 'ipa', 'out', 'go'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--unit', type=Path, action='append', default=[])
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    args.out.chmod(0o700)
    origin = args.origin.resolve()
    head = subprocess.check_output(['git', '-C', str(origin), 'rev-parse', 'HEAD'], text=True).strip()
    status = subprocess.check_output(['git', '-C', str(origin), 'status', '--porcelain'], text=True)
    if status:
        raise SystemExit('Reference must be clean; preserve user changes before freezing baseline')
    subprocess.run(['git', '-C', str(origin), 'bundle', 'create', str(args.out.resolve() / 'source.bundle'), '--all'], check=True)
    shutil.copytree(args.server, args.out / 'stable-server')
    shutil.copyfile(args.ipa, args.out / 'stable.ipa')
    units = []
    for index, unit in enumerate(args.unit):
        target = args.out / f'unit-{index}.conf'
        shutil.copyfile(unit, target)
        units.append({'original': str(unit), 'backup': target.name, 'sha256': digest(target)})
    metadata = {}
    with zipfile.ZipFile(args.ipa) as ipa:
        for name in ipa.namelist():
            if name.count('/') == 2 and name.endswith(('/Info.plist', '/Expo.plist')):
                data = plistlib.loads(ipa.read(name))
                for key in ('CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'EXUpdatesRuntimeVersion'):
                    if key in data:
                        metadata[key] = data[key]
        fingerprints = [name for name in ipa.namelist() if name.endswith('/EXUpdates.bundle/fingerprint')]
        if len(fingerprints) == 1:
            metadata['resolved_runtime_fingerprint'] = ipa.read(fingerprints[0]).decode().strip()
    services = subprocess.run(['systemctl', '--user', 'show', 'phonepad-preview.service', 'phonepad.service',
                               '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'],
                              capture_output=True, text=True)
    manifest = {
        'schema_version': 1, 'reference_commit': head, 'reference_clean': True,
        'origin': str(origin), 'server_origin': str(args.server), 'ipa_origin': str(args.ipa),
        'ipa_metadata': metadata, 'service_config_backups': units,
        'service_observation': {'returncode': services.returncode, 'properties': services.stdout,
                                'error': services.stderr.strip()},
        'versions': {},
        'resources': {
            'ios_native_build': 'pending: no Xcode on this Linux host; signing not checked',
            'physical_phone': 'pending: no device acceptance in this run',
            'android_native_build': 'pending: SDK/JDK not found on PATH; no receiver build verified',
            'stable_ipa': 'preserved; installed-device parity and signature validity not revalidated',
        },
        'files': {},
    }
    for name, command in [('python', ['python3', '--version']), ('node', ['node', '--version']),
                          ('go', [str(args.go), 'version']), ('gstreamer', ['gst-launch-1.0', '--version'])]:
        result = subprocess.run(command, capture_output=True, text=True)
        manifest['versions'][name] = {'returncode': result.returncode, 'output': result.stdout.strip()}
    for path in sorted(args.out.rglob('*')):
        if path.is_file():
            manifest['files'][str(path.relative_to(args.out))] = digest(path)
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'manifest': str(args.out / 'manifest.json'), 'commit': head,
                      'files_preserved': len(manifest['files']), 'ipa': metadata,
                      'service_query_returncode': services.returncode}))


if __name__ == '__main__':
    main()
