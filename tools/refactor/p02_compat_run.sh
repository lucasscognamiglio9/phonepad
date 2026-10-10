#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
archive=${PHONEPAD_COMPAT_ARCHIVE:-$repo_root/outputs/temporal/p02-07-compat/adab7c77}
go_bin=${PHONEPAD_COMPAT_GO:-$(command -v go || true)}
if [[ -z "$go_bin" ]]; then
  echo 'Go is required. Set PHONEPAD_COMPAT_GO or add Go to PATH.' >&2
  exit 1
fi

mkdir -p "$archive"
git -C "$repo_root" archive --format=tar adab7c77 | tar -xf - -C "$archive"

export PHONEPAD_COMPAT_INTEROP=1
export PHONEPAD_COMPAT_ARCHIVE="$archive"
export PHONEPAD_COMPAT_CLIENT_SCRIPT="$script_dir/p02_compat_connection.cjs"
export PHONEPAD_COMPAT_GO="$go_bin"
export GOPROXY=off
export GOCACHE=${GOCACHE:-$archive/go-cache}

cd "$repo_root/daemon"
exec "$go_bin" test -mod=vendor ./internal/server -run '^TestP02Compatibility$' -count=1
