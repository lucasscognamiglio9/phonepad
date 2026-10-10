"""Private directories and atomic persistence for capture authorization."""
import json
import os
import stat
import tempfile
from pathlib import Path


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise PermissionError('Capture directory must be owned by the current user and not be a symlink')
    path.chmod(0o700)
    return path


def capture_directories():
    value = os.environ.get('XDG_RUNTIME_DIR', '')
    runtime = Path(value)
    if not value or not runtime.is_absolute():
        raise PermissionError('XDG_RUNTIME_DIR must identify a private runtime directory')
    info = runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PermissionError('XDG_RUNTIME_DIR must be owned by the current user with mode 0700')
    root = private_directory(runtime / 'phonepad-preview')
    config = private_directory(Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'phonepad')
    return root, config


def save_private_json(path, value):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.capture-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
