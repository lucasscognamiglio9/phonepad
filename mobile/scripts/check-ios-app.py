"""Reject incomplete or simulator archives before calling them an iPhone build."""
import json
import plistlib
import re
import struct
import sys
from pathlib import Path


def check_app(app):
    app = Path(app)
    with (app / 'Info.plist').open('rb') as file:
        info = plistlib.load(file)
    if info.get('CFBundleSupportedPlatforms') != ['iPhoneOS']:
        raise ValueError('El archive no es para un iPhone físico.')
    sdk = re.fullmatch(r'iphoneos(\d+)(?:\.\d+)*', info.get('DTSDKName', ''))
    if not sdk or int(sdk.group(1)) < 26:
        raise ValueError('El SDK del archive no permite comprobar Liquid Glass de iOS 26.')
    executable = info.get('CFBundleExecutable', '')
    if not executable or Path(executable).name != executable:
        raise ValueError('Ejecutable de app inválido.')
    with (app / executable).open('rb') as file:
        magic, cpu = struct.unpack('<II', file.read(8))
    if (magic, cpu) != (0xFEEDFACF, 0x0100000C):
        raise ValueError('Se esperaba el ejecutable Mach-O arm64 de iPhone.')
    bundle = app / 'main.jsbundle'
    if not bundle.is_file() or bundle.stat().st_size == 0:
        raise ValueError('Falta el código incluido: esta app dependería de Metro.')
    if not (app / 'Frameworks/WebRTC.framework/WebRTC').is_file():
        raise ValueError('Falta WebRTC nativo en el archive.')
    if info.get('NSMicrophoneUsageDescription'):
        raise ValueError('El build agregó permisos de micrófono no usados por Phonepad.')
    if not info.get('NSCameraUsageDescription'):
        raise ValueError('Falta el permiso de cámara solicitado para fotos.')
    if not info.get('CADisableMinimumFrameDurationOnPhone'):
        raise ValueError('La configuración de ProMotion no está presente.')
    with (app / 'Expo.plist').open('rb') as file:
        updates = plistlib.load(file)
    if not updates.get('EXUpdatesEnabled'):
        raise ValueError('Las actualizaciones OTA no están habilitadas en el binario.')
    if updates.get('EXUpdatesURL') != 'https://u.expo.dev/a424819c-da67-44c6-bf43-8a09b2e554a2':
        raise ValueError('El servidor OTA no coincide con el proyecto Phonepad.')
    channel = updates.get('EXUpdatesRequestHeaders', {}).get('expo-channel-name')
    if channel != 'personal':
        raise ValueError('El canal OTA no es personal.')
    runtime = updates.get('EXUpdatesRuntimeVersion', '')
    if runtime == 'file:fingerprint':
        runtime = (app / 'EXUpdates.bundle/fingerprint').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40,64}', runtime):
        raise ValueError('Falta un fingerprint de compatibilidad nativa válido.')
    if updates.get('EXUpdatesDisableAntiBrickingMeasures') or updates.get('EXUpdatesHasEmbeddedUpdate') is False:
        raise ValueError('La recuperación a una versión incluida debe permanecer habilitada.')
    if updates.get('EXUpdatesLaunchWaitMs') != 0:
        raise ValueError('El inicio no debe esperar a descargar actualizaciones.')
    manifest = json.loads((app / 'EXUpdates.bundle/app.manifest').read_text())
    if not manifest.get('id'):
        raise ValueError('Falta el manifiesto de la versión incluida.')
    return {'bundleIdentifier': info.get('CFBundleIdentifier'), 'sdk': info['DTSDKName'],
            'architecture': 'arm64', 'embeddedBundleBytes': bundle.stat().st_size,
            'otaEnabled': True, 'otaChannel': channel, 'runtimeVersion': runtime,
            'signing': 'pending local personal signing', 'nativeDeviceTested': False}


if __name__ == '__main__':
    try:
        print(json.dumps(check_app(sys.argv[1]), indent=2))
    except (IndexError, OSError, ValueError, struct.error) as error:
        raise SystemExit(str(error)) from error
