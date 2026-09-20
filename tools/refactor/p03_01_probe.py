#!/usr/bin/env python3
"""Probe the GStreamer pieces relevant to the P03.1 WebRTC experiment.

The probe only invokes ``gst-inspect-1.0``.  It does not start a pipeline,
open a network socket, change network configuration, or alter the system
registry.  A private registry is used for each profile so the result is
repeatable and does not touch a user's GStreamer cache.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ELEMENTS = (
    "rtpgccbwe",
    "webrtcsink",
    "webrtcbin",
    "rtphdrexttwcc",
    "rtpjitterbuffer",
    "rtph264pay",
    "vah264enc",
    "vaapih264enc",
    "vapostproc",
    "vaapipostproc",
)

RUNTIME_FILES = (
    "video-plugins/libgstwebrtc.so",
    "video-plugins/libgstvaapi.so",
    "video-modern/plugins/libgstva.so",
    "video-modern/lib/libgstva-1.0.so.0.2802.0",
)


def _run(command, env, timeout=8):
    try:
        result = subprocess.run(
            command,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "available": False,
            "returncode": None,
            "output": str(error),
        }
    output = (result.stdout + "\n" + result.stderr).strip()
    return {
        "available": result.returncode == 0,
        "returncode": result.returncode,
        "output": output[:2400],
    }


def _profile_env(root, registry):
    env = os.environ.copy()
    env["GST_REGISTRY"] = str(registry)
    if root is None:
        return env

    root = Path(root)
    modern_lib = root / "video-modern" / "lib"
    extracted_lib = root / "video-packages" / "extracted" / "usr" / "lib" / "x86_64-linux-gnu"
    modern_plugins = root / "video-modern" / "plugins"
    runtime_plugins = root / "video-plugins"
    driver_dir = root / "video-packages" / "full-driver" / "usr" / "lib" / "x86_64-linux-gnu" / "dri"
    typelib_dir = root / "video-packages" / "extracted" / "usr" / "lib" / "x86_64-linux-gnu" / "girepository-1.0"

    env["LD_LIBRARY_PATH"] = os.pathsep.join(
        str(path) for path in (modern_lib, extracted_lib) if path.is_dir()
    )
    env["GST_PLUGIN_PATH"] = os.pathsep.join(
        str(path) for path in (modern_plugins, runtime_plugins) if path.is_dir()
    )
    if driver_dir.is_dir():
        env["LIBVA_DRIVERS_PATH"] = str(driver_dir)
    if typelib_dir.is_dir():
        env["GI_TYPELIB_PATH"] = str(typelib_dir)
    return env


def _probe_profile(name, root, temp_root):
    env = _profile_env(root, temp_root / (name + ".bin"))
    version = _run(["gst-inspect-1.0", "--version"], env)
    elements = {
        element: _run(["gst-inspect-1.0", element], env)
        for element in ELEMENTS
    }
    return {"name": name, "version": version, "elements": elements}


def _runtime_inventory(root):
    if root is None:
        return {"root": None, "files": {}}
    root = Path(root)
    return {
        "root": str(root),
        "files": {
            relative: (root / relative).is_file()
            for relative in RUNTIME_FILES
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runtime",
        type=Path,
        default=(os.environ.get("PHONEPAD_RUNTIME") or os.environ.get("PHONEPAD_LAB_RUNTIME")),
        help="optional isolated Phonepad runtime root",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="write JSON here (otherwise print it); the parent must already exist",
    )
    args = parser.parse_args()
    gst_inspect = shutil.which("gst-inspect-1.0")
    if not gst_inspect:
        raise SystemExit("gst-inspect-1.0 not found")

    runtime = Path(args.runtime).resolve() if args.runtime else None
    with tempfile.TemporaryDirectory(prefix="phonepad-p03-01-") as temporary:
        temporary = Path(temporary)
        profiles = [_probe_profile("system", None, temporary)]
        if runtime is not None:
            profiles.append(_probe_profile("phonepad-runtime", runtime, temporary))

        result = {
            "schema": "phonepad.p03-01.gstreamer-probe.v1",
            "tool": gst_inspect,
            "profiles": profiles,
            "runtime": _runtime_inventory(runtime),
            "probe_limits": {
                "drm_directory_present": Path("/dev/dri").exists(),
                "note": "A missing /dev/dri can prevent VA feature enumeration; it does not prove the VA plugin artifact is absent.",
            },
        }

    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
