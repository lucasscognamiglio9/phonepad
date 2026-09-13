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
            'EXUpdatesURL': 'https://u.expo.dev/a424819c-da67-44c6-bf43-8a09b2e554a2',
            'EXUpdatesRequestHeaders': {'expo-channel-name': 'personal'},
            'EXUpdatesRuntimeVersion': 'file:fingerprint', 'EXUpdatesLaunchWaitMs': 0,
        }
        self.write_updates()
        resources = self.app / 'EXUpdates.bundle'
        resources.mkdir()
        (resources / 'fingerprint').write_text('a' * 40)
        (resources / 'app.manifest').write_text('{"id":"fixture"}')

    def write_info(self):
        (self.app / 'Info.plist').write_bytes(plistlib.dumps(self.info))

    def write_updates(self):
        (self.app / 'Expo.plist').write_bytes(plistlib.dumps(self.updates))

    def test_complete_package_still_reports_unsigned_and_untested(self):
        result = archive.check_app(self.app)
        self.assertFalse(result['nativeDeviceTested'])
        self.assertEqual(result['signing'], 'pending local personal signing')

    def test_arm64_simulator_is_not_a_device_build(self):
        self.info['CFBundleSupportedPlatforms'] = ['iPhoneSimulator']
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'iPhone físico'):
            archive.check_app(self.app)

    def test_metro_dependent_app_is_rejected(self):
        (self.app / 'main.jsbundle').unlink()
        with self.assertRaisesRegex(ValueError, 'Metro'):
            archive.check_app(self.app)

    def test_missing_native_video_is_rejected(self):
        (self.app / 'Frameworks/WebRTC.framework/WebRTC').unlink()
        with self.assertRaisesRegex(ValueError, 'WebRTC'):
            archive.check_app(self.app)

    def test_accidental_recording_permission_is_rejected(self):
        self.info['NSMicrophoneUsageDescription'] = 'unexpected'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'permisos'):
            archive.check_app(self.app)

    def test_pre_glass_sdk_is_rejected(self):
        self.info['DTSDKName'] = 'iphoneos18.5'
        self.write_info()
        with self.assertRaisesRegex(ValueError, 'Liquid Glass'):
            archive.check_app(self.app)

    def test_wrong_update_channel_is_rejected(self):
        self.updates['EXUpdatesRequestHeaders']['expo-channel-name'] = 'wrong'
        self.write_updates()
        with self.assertRaisesRegex(ValueError, 'canal OTA'):
            archive.check_app(self.app)

    def test_missing_runtime_fingerprint_is_rejected(self):
        (self.app / 'EXUpdates.bundle/fingerprint').write_text('')
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            archive.check_app(self.app)
