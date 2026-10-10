#!/usr/bin/env bash
set -euo pipefail

# Pinned source snapshot. The output is always private; this script never
# installs into /usr or changes the Phonepad runtime.
commit=b0544c4596f4f4ee4c5602918a4849e5ef51ee6d
archive_sha256=6b5c1d3aba84fada30585aa5ab6a7a41e9e9f45c68f50db7aaf1b5ca71c686cd
archive_url="https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/archive/${commit}/gst-plugins-rs-${commit}.tar.gz"

usage() {
    cat <<'EOF'
Usage: p03_01_build_rsrtp.sh [--download] [--online] [--root DIR] [--sdk-root DIR]

--download  fetch and extract the pinned official source under DIR/source
--online    allow Cargo to fetch the locked official git dependencies
--root DIR  private audit/build directory (default: /tmp/phonepad-p03-01-rsrtp-COMMIT)
--sdk-root DIR
             use the private SDK layout DIR/{rust,sysroot}; this sets PATH,
             pkg-config and the dynamic-library search path without installing
             anything on the host

The build produces DIR/plugin/gstreamer-1.0/libgstrsrtp.so. It does not copy
anything to a system or Phonepad runtime directory.
EOF
}

download=0
online=0
sdk_root=''
root="${PHONEPAD_P03_01_ROOT:-/tmp/phonepad-p03-01-rsrtp-${commit}}"
while (($#)); do
    case "$1" in
        --download) download=1 ;;
        --online) online=1 ;;
        --root)
            shift
            (($#)) || { echo '--root needs a directory' >&2; exit 2; }
            root=$1
            ;;
        --sdk-root)
            shift
            (($#)) || { echo '--sdk-root needs a directory' >&2; exit 2; }
            sdk_root=$1
            ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

root=$(mkdir -p "$root" && cd "$root" && pwd)
archive="$root/gst-plugins-rs-${commit}.tar.gz"
source_root="$root/source"

if [[ -n "$sdk_root" ]]; then
    sdk_root=$(cd "$sdk_root" && pwd)
    [[ -x "$sdk_root/rust/bin/cargo" && -x "$sdk_root/rust/bin/rustc" ]] || {
        echo "private Rust toolchain missing under $sdk_root/rust/bin" >&2
        exit 2
    }
    [[ -d "$sdk_root/sysroot" ]] || {
        echo "private sysroot missing: $sdk_root/sysroot" >&2
        exit 2
    }
    export PATH="$sdk_root/rust/bin:$sdk_root/sysroot/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$sdk_root/sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export PKG_CONFIG_SYSROOT_DIR="$sdk_root/sysroot"
    export PKG_CONFIG_LIBDIR="$sdk_root/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$sdk_root/sysroot/usr/share/pkgconfig"
fi

if [[ ! -d "$source_root/net/rtp" ]]; then
    ((download)) || {
        echo "source missing: $source_root (rerun with --download)" >&2
        exit 2
    }
    command -v curl >/dev/null || { echo 'missing prerequisite: curl' >&2; exit 2; }
    command -v tar >/dev/null || { echo 'missing prerequisite: tar' >&2; exit 2; }
    if [[ ! -e "$archive" ]]; then
        curl --fail --location --max-time 180 --silent --show-error "$archive_url" -o "$archive"
    fi
    printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --strict
    [[ ! -e "$source_root" ]] || { echo "refusing to overwrite $source_root" >&2; exit 2; }
    mkdir "$source_root"
    tar --extract --gzip --file "$archive" --directory "$source_root" --strip-components=1
    printf '%s\n' "$commit" > "$source_root/.phonepad-p03-01-commit"
fi

source_commit=''
if command -v git >/dev/null && git -C "$source_root" rev-parse HEAD >/dev/null 2>&1; then
    source_commit=$(git -C "$source_root" rev-parse HEAD)
elif [[ -f "$source_root/.phonepad-p03-01-commit" ]]; then
    source_commit=$(cat "$source_root/.phonepad-p03-01-commit")
fi
[[ "$source_commit" == "$commit" ]] || {
    echo "source commit mismatch: expected $commit, got ${source_commit:-unknown}" >&2
    exit 2
}

missing=()
command -v cargo >/dev/null || missing+=("cargo (Rust >= 1.92 required by this snapshot)")
if command -v rustc >/dev/null; then
    rust_version=$(rustc --version | awk '{print $2}')
    rust_major=${rust_version%%.*}
    rust_minor=${rust_version#*.}
    rust_minor=${rust_minor%%.*}
    if [[ ! "$rust_major" =~ ^[0-9]+$ || ! "$rust_minor" =~ ^[0-9]+$ ]] ||
        ((rust_major < 1 || (rust_major == 1 && rust_minor < 92))); then
        missing+=("rustc $rust_version (Rust >= 1.92 required by this snapshot)")
    fi
else
    missing+=("rustc (Rust >= 1.92 required by this snapshot)")
fi
command -v pkg-config >/dev/null || missing+=("pkg-config")
if command -v pkg-config >/dev/null; then
    for package in \
        gstreamer-1.0 gstreamer-base-1.0 gstreamer-rtp-1.0 \
        gstreamer-net-1.0 gstreamer-video-1.0 glib-2.0 gobject-2.0 \
        gmodule-2.0 gio-2.0; do
        pkg-config --exists "$package" || missing+=("pkg-config:${package}")
    done
fi
if ((${#missing[@]})); then
    printf 'build preflight blocked; missing:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 3
fi

build_root="$root/build"
prefix="$root/plugin"
mkdir -p "$build_root" "$prefix/gstreamer-1.0"
export CARGO_HOME="$root/cargo-home"
export CARGO_TARGET_DIR="$build_root/target"
if ((!online)); then
    export CARGO_NET_OFFLINE=true
fi

cargo build --locked --manifest-path "$source_root/Cargo.toml" \
    --release --package gst-plugin-rtp
plugin="$CARGO_TARGET_DIR/release/libgstrsrtp.so"
[[ -f "$plugin" ]] || { echo "Cargo produced no $plugin" >&2; exit 4; }
cp "$plugin" "$prefix/gstreamer-1.0/libgstrsrtp.so"
chmod 0755 "$prefix/gstreamer-1.0/libgstrsrtp.so"
sha256sum "$prefix/gstreamer-1.0/libgstrsrtp.so"
printf 'private plugin directory: %s\n' "$prefix/gstreamer-1.0"

if command -v gst-inspect-1.0 >/dev/null; then
    GST_PLUGIN_PATH="$prefix/gstreamer-1.0${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}" \
        GST_REGISTRY="$root/registry.bin" \
        gst-inspect-1.0 rtpgccbwe
fi
