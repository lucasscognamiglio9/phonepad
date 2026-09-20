#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
archive=${PHONEPAD_COMPAT_ARCHIVE:-$repo_root/outputs/temporal/p02-07-compat/adab7c77}
go_bin=${PHONEPAD_COMPAT_GO:-/home/luque/Documents/Codex/2026-09-08/phonepad/work/runtime/go/bin/go}

mkdir -p "$archive"
git -C "$repo_root" archive --format=tar adab7c77 | tar -xf - -C "$archive"

export PHONEPAD_COMPAT_INTEROP=1
export PHONEPAD_COMPAT_ARCHIVE="$archive"
export PHONEPAD_COMPAT_CLIENT_SCRIPT="$script_dir/p02_compat_connection.cjs"
export PHONEPAD_COMPAT_GO="$go_bin"
export GOPROXY=off
export GOCACHE=${GOCACHE:-/tmp/phonepad-refactor-go-cache}

cd "$repo_root/daemon"
exec "$go_bin" test -mod=vendor ./internal/server -run '^TestP02Compatibility$' -count=1
