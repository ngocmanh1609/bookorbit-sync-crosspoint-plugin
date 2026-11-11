#!/bin/sh
# Builds dist/cp-orbit-<version>.zip with one top-level cp-orbit/ folder, ready to
# copy into /plugins/ on the SD card. Only the files declared in manifest.json ship.
# The folder is not named cp-orbit.crosspoint-plugin: the firmware only sends plugin
# events for folder names of 23 bytes or fewer.
set -eu
cd "$(dirname "$0")/.."
SRC=cp-orbit.crosspoint-plugin
VERSION=$(node -p "require('./$SRC/manifest.json').version")
if [ -n "${1:-}" ] && [ "${1#v}" != "$VERSION" ]; then
  echo "Version $1 does not match manifest.json ($VERSION)" >&2
  exit 1
fi
OUT=${OUT_DIR:-dist}
mkdir -p "$OUT"
ZIP="$(cd "$OUT" && pwd)/cp-orbit-$VERSION.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/cp-orbit"
for f in $(node -p "require('./$SRC/manifest.json').files.join(' ')"); do
  cp "$SRC/$f" "$STAGE/cp-orbit/$f"
done
rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" cp-orbit)
echo "$ZIP"
