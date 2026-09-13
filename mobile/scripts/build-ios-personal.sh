#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Este paso necesita un Mac con Xcode. Usá el perfil EAS personal desde Linux.' >&2
  exit 1
fi
for tool in xcodebuild xcrun pod node python3 ditto; do
  command -v "$tool" >/dev/null || { echo "Falta $tool en el builder." >&2; exit 1; }
done

# iOS 26's native glass must be compiled with a supporting SDK.
python3 - <<'PY'
import re, subprocess
version = subprocess.check_output(['xcodebuild', '-version'], text=True)
print(version.strip())
match = re.search(r'Xcode (\d+)', version)
if not match or int(match.group(1)) < 26:
    raise SystemExit('Se requiere Xcode 26 o posterior para Liquid Glass.')
PY

export CI=1 EXPO_NO_TELEMETRY=1 RCT_NO_LAUNCH_PACKAGER=1
export NODE_BINARY="$(command -v node)"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/phonepad-ios.XXXXXX")"
trap 'rm -rf "$build_root"' EXIT
mkdir -p build

npx --no-install expo prebuild --platform ios --no-install
(
  cd ios
  pod install
)

# Archive iphoneos/arm64, not the Simulator. Signing happens on the user's
# computer with their free Apple account, never with an Apple secret in EAS.
xcodebuild \
  -workspace ios/Phonepad.xcworkspace \
  -scheme Phonepad \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$build_root/derived" \
  -archivePath "$build_root/Phonepad.xcarchive" \
  archive \
  ARCHS=arm64 \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  DEVELOPMENT_TEAM=''

app="$build_root/Phonepad.xcarchive/Products/Applications/Phonepad.app"
python3 scripts/check-ios-app.py "$app"
mkdir -p "$build_root/Payload"
ditto "$app" "$build_root/Payload/Phonepad.app"
ditto -c -k --sequesterRsrc --keepParent "$build_root/Payload" build/Phonepad-unsigned.ipa
shasum -a 256 build/Phonepad-unsigned.ipa
echo 'IPA creada para firma personal local. No se instala directamente desde Safari ni TestFlight.'
