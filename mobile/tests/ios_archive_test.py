"""Packaging checks only: fixture success is not a real Xcode/device test."""
import importlib.util
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'ios_archive', Path(__file__).resolve().parents[1] / 'scripts/check-ios-app.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / 'Phonepad.app'
        self.app.mkdir()
        self.config = {'updates': {
            'enabled': True,
            'url': 'https://u.expo.dev/00000000-0000-4000-8000-000000000000',
            'requestHeaders': {'expo-channel-name': 'preview'},
        }}
        self.info = {
            'CFBundleIdentifier': 'app.phonepad.mobile',
            'CFBundleSupportedPlatforms': ['iPhoneOS'],
            'DTSDKName': 'iphoneos26.6', 'CFBundleExecutable': 'Phonepad',
            'CADisableMinimumFrameDurationOnPhone': True,
            'NSCameraUsageDescription': 'Take a photo to send to your computer',
        }
        self.write_info()
        (self.app / 'Phonepad').write_bytes(struct.pack('<II', 0xFEEDFACF, 0x0100000C))
        (self.app / 'main.jsbundle').write_bytes(b'fixture bundle')
        rtc = self.app / 'Frameworks/WebRTC.framework/WebRTC'
        rtc.parent.mkdir(parents=True)
        rtc.write_bytes(b'fixture framework')
        self.updates = {
            'EXUpdatesEnabled': True,
            'EXUpdatesURL': self.config['updates']['url'],
            'EXUpdatesRequestHeaders': self.config['updates']['requestHeaders'].copy(),
            'EXUpdatesRuntimeVersion': 'file:fingerprint', 'EXUpdatesLaunchWaitMs': 0,
        }
        self.write_updates()
        resources = self.app / 'EXUpdates.bundle'
        resources.mkdir()
        (resources / 'fingerprint').write_text('a' * 40)
        (resources / 'app.manifest').write_text('{"id":"fixture"}')

    def write_info(self):
        (self.app / 'Info.plist').write_bytes(plistlib.dumps(self.info))

    def check(self):
        return archive.check_app(self.app, self.config)

    def write_updates(self):
        (self.app / 'Expo.plist').write_bytes(plistlib.dumps(self.updates))

    def test_complete_package_still_reports_unsigned_and_untested(self):
        result = self.check()
        self.assertFalse(result['nativeDeviceTested'])
        self.assertEqual(result['signing'], 'pending local personal signing')

    def test_arm64_simulator_is_not_a_device_build(self):
        self.info['CFBundleSupportedPlatforms'] = ['iPhoneSimulator']
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'iPhone físico'):
            self.check()

    def test_metro_dependent_app_is_rejected(self):
        (self.app / 'main.jsbundle').unlink()
        with self.assertRaisesRegex(ValueError, 'Metro'):
            self.check()

    def test_missing_native_video_is_rejected(self):
        (self.app / 'Frameworks/WebRTC.framework/WebRTC').unlink()
        with self.assertRaisesRegex(ValueError, 'WebRTC'):
            self.check()

    def test_accidental_recording_permission_is_rejected(self):
        self.info['NSMicrophoneUsageDescription'] = 'unexpected'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'permisos'):
            self.check()

    def test_pre_glass_sdk_is_rejected(self):
        self.info['DTSDKName'] = 'iphoneos18.5'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'Liquid Glass'):
            self.check()

    def test_wrong_update_channel_is_rejected(self):
        self.updates['EXUpdatesRequestHeaders']['expo-channel-name'] = 'wrong'
        self.write_updates()
        with self.assertRaisesRegex(ValueError, 'canal OTA'):
            self.check()

    def test_missing_runtime_fingerprint_is_rejected(self):
        (self.app / 'EXUpdates.bundle/fingerprint').write_text('')
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            self.check()

    def test_public_build_does_not_enable_owner_updates(self):
        self.config['updates'] = {'enabled': False}
        self.updates = {'EXUpdatesEnabled': False}
        self.write_updates()
        result = self.check()
        self.assertFalse(result['otaEnabled'])
        self.assertIsNone(result['otaChannel'])

    def test_old_personal_update_build_is_rejected_by_public_config(self):
        self.config['updates'] = {'enabled': False}
        with self.assertRaisesRegex(ValueError, 'configuración OTA'):
            self.check()

    def test_foreign_update_project_is_rejected(self):
        self.updates['EXUpdatesURL'] = 'https://u.expo.dev/11111111-1111-4111-8111-111111111111'
        self.write_updates()
        with self.assertRaisesRegex(ValueError, 'servidor OTA'):
            self.check()

    def test_disabled_updates_cannot_retain_a_previous_destination(self):
        self.config['updates'] = {'enabled': False}
        self.updates['EXUpdatesEnabled'] = False
        self.write_updates()
        with self.assertRaisesRegex(ValueError, 'canal OTA desactivado'):
            self.check()

    def test_personal_provisioning_profile_is_rejected(self):
        (self.app / 'embedded.mobileprovision').write_bytes(b'fixture profile')
        with self.assertRaisesRegex(ValueError, 'perfil personal'):
            self.check()

    def test_configured_build_and_identifier_are_checked(self):
        self.config['ios'] = {'bundleIdentifier': 'app.phonepad.mobile', 'buildNumber': '6'}
        self.info['CFBundleVersion'] = '6'
        self.write_info()
        self.check()
        self.info['CFBundleVersion'] = '5'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'número de build'):
            self.check()
        self.info['CFBundleVersion'] = '6'
        self.info['CFBundleIdentifier'] = 'other.app'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'identificador'):
            self.check()
