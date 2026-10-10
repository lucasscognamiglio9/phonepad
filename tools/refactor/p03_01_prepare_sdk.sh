#!/usr/bin/env bash
set -euo pipefail

# Prepare a disposable SDK for p03_01_build_rsrtp.sh.  This script never uses
# sudo and never installs into /usr or the Phonepad runtime.
rust_version=1.98.1
rust_date=2026-09-03
rust_host=x86_64-unknown-linux-gnu
rust_sha256=24ba1338a2d35c5a3247936546429e163fa674d726102af18bdf624582c57aea
rust_url="https://static.rust-lang.org/dist/${rust_date}/rust-${rust_version}-${rust_host}.tar.gz"
sdk_root="${PHONEPAD_P03_01_SDK:-/tmp/phonepad-p03-01-sdk}"

packages=(
    pkg-config=2.5.1-4
    libgstreamer1.0-dev=1.28.2-1
    libgstreamer-plugins-base1.0-dev=1.28.2-1
    libglib2.0-dev=2.88.0-1
    libgstreamer1.0-0=1.28.2-1
    libgstreamer-plugins-base1.0-0=1.28.2-1
    libglib2.0-0t64=2.88.0-1
)

usage() {
    cat <<'EOF'
Usage: p03_01_prepare_sdk.sh [--root DIR]

Downloads the pinned official Rust archive and exact Ubuntu development
packages into DIR, extracts them to DIR/{rust,sysroot}, and writes a hash and
version manifest to DIR/sdk-manifest.txt. No system package installation is
performed.
EOF
}

while (($#)); do
    case "$1" in
        --root)
            shift
            (($#)) || { echo '--root needs a directory' >&2; exit 2; }
            sdk_root=$1
            ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

command -v curl >/dev/null || { echo 'missing prerequisite: curl' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'missing prerequisite: sha256sum' >&2; exit 2; }
command -v tar >/dev/null || { echo 'missing prerequisite: tar' >&2; exit 2; }
command -v apt-get >/dev/null || { echo 'missing prerequisite: apt-get' >&2; exit 2; }
command -v dpkg-deb >/dev/null || { echo 'missing prerequisite: dpkg-deb' >&2; exit 2; }

sdk_root=$(mkdir -p "$sdk_root" && cd "$sdk_root" && pwd)
downloads="$sdk_root/downloads"
apt_root="$sdk_root/apt-cache"
archives="$apt_root/archives"
mkdir -p "$downloads" "$archives" "$sdk_root/sysroot" "$sdk_root/rust"

rust_archive="$downloads/rust-${rust_version}-${rust_host}.tar.gz"
if [[ ! -e "$rust_archive" ]]; then
    curl --fail --location --max-time 300 --silent --show-error "$rust_url" -o "$rust_archive"
fi
printf '%s  %s\n' "$rust_sha256" "$rust_archive" | sha256sum --check --strict

unpack="$sdk_root/.rust-unpack"
if [[ ! -x "$sdk_root/rust/bin/rustc" ]]; then
    rm -rf "$unpack"
    mkdir "$unpack"
    tar --extract --gzip --file "$rust_archive" --directory "$unpack" --strip-components=1
    bash "$unpack/install.sh" \
        --prefix="$sdk_root/rust" \
        --disable-ldconfig \
        --components=rustc,rust-std-${rust_host},cargo
    rm -rf "$unpack"
fi

# apt-get resolves transitive dependencies into this private cache.  Exact
# versions are intentional; if the archive is no longer available, fail
# instead of silently changing the ABI under test.
apt-get --download-only --no-install-recommends --yes \
    -o Debug::NoLocking=true \
    -o Dir::Cache="$apt_root" \
    -o Dir::Cache::archives="$archives" \
    --option=APT::Keep-Downloaded-Packages=true \
    install "${packages[@]}"

find "$archives" -maxdepth 1 -type f -name '*.deb' -print0 |
    while IFS= read -r -d '' deb; do
        dpkg-deb -x "$deb" "$sdk_root/sysroot"
    done

export PATH="$sdk_root/rust/bin:$sdk_root/sysroot/usr/bin:$PATH"
export LD_LIBRARY_PATH="$sdk_root/sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PKG_CONFIG_SYSROOT_DIR="$sdk_root/sysroot"
export PKG_CONFIG_LIBDIR="$sdk_root/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$sdk_root/sysroot/usr/share/pkgconfig"

for command in rustc cargo pkg-config; do
    command -v "$command" >/dev/null || { echo "SDK command missing: $command" >&2; exit 3; }
done
for module in \
    gstreamer-1.0 gstreamer-base-1.0 gstreamer-rtp-1.0 \
    gstreamer-net-1.0 gstreamer-video-1.0 glib-2.0 gobject-2.0 \
    gmodule-2.0 gio-2.0; do
    pkg-config --exists "$module" || { echo "SDK pkg-config module missing: $module" >&2; exit 3; }
done

manifest="$sdk_root/sdk-manifest.txt"
{
    printf 'rust_url=%s\n' "$rust_url"
    printf 'rust_sha256=%s\n' "$rust_sha256"
    rustc --version --verbose
    cargo --version
    printf '\nprivate pkg-config modules:\n'
    for module in \
        gstreamer-1.0 gstreamer-base-1.0 gstreamer-rtp-1.0 \
        gstreamer-net-1.0 gstreamer-video-1.0 glib-2.0 gobject-2.0 \
        gmodule-2.0 gio-2.0; do
        printf '%s=%s\n' "$module" "$(pkg-config --modversion "$module")"
    done
    printf '\nDebian archive hashes:\n'
    sha256sum "$archives"/*.deb
} > "$manifest"

printf 'private SDK ready: %s\nmanifest: %s\n' "$sdk_root" "$manifest"
