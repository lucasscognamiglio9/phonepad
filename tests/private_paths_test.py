import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'setup/preview'))
from private_paths import capture_directories, private_directory, save_private_json


class PrivatePathsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_missing_runtime_does_not_use_shared_tmp(self):
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': ''}):
            with self.assertRaises(PermissionError):
                capture_directories()

    def test_shared_runtime_is_rejected(self):
        self.root.chmod(0o755)
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(self.root)}):
            with self.assertRaises(PermissionError):
                capture_directories()

    def test_capture_and_config_directories_are_private(self):
        config = self.root / 'config'
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(self.root), 'XDG_CONFIG_HOME': str(config)}):
            runtime, folder = capture_directories()
        for path in (runtime, folder):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)

    def test_existing_symlink_is_rejected_without_changing_target(self):
        target = self.root / 'target'
        target.mkdir(mode=0o755)
        link = self.root / 'link'
        link.symlink_to(target)
        before = target.stat().st_mode
        with self.assertRaises(PermissionError):
            private_directory(link)
        self.assertEqual(target.stat().st_mode, before)

    def test_restore_token_is_atomically_replaced_with_private_permissions(self):
        path = self.root / 'restore.json'
        path.write_text('old')
        path.chmod(0o644)
        save_private_json(path, {'token': 'fixture'})
        self.assertEqual(json.loads(path.read_text()), {'token': 'fixture'})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual([file.name for file in self.root.iterdir()], ['restore.json'])
