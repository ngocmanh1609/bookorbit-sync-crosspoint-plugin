#!/bin/sh
# Uploads the cp-orbit payload to a CrossPoint reader's web server (File Transfer must be open).
#   sh .claude/skills/deploy-to-picco/scripts/deploy.sh <reader-ip-or-host> [file ...]
# With no files, every file in manifest.json "files" is sent. DRY_RUN=1 prints the requests only.
set -eu
cd "$(dirname "$0")/../../../.."
SRC=cp-orbit.crosspoint-plugin
READER=${1:?usage: deploy.sh <reader-ip> [file ...]}
shift
case "$READER" in http://*|https://*) BASE=$READER ;; *) BASE="http://$READER" ;; esac
if [ "$#" -eq 0 ]; then set -- $(node -p "require('./$SRC/manifest.json').files.join(' ')"); fi

for f in "$@"; do
  [ -f "$SRC/$f" ] || { echo "not a payload file: $f" >&2; exit 1; }
done

run() {
  if [ "${DRY_RUN:-}" = 1 ]; then echo "+ $*"; else "$@"; fi
}

# /mkdir answers 400 "Folder already exists" on repeat runs; that is fine.
run curl -s -o /dev/null -X POST -d "name=plugins&path=/" "$BASE/mkdir" || true
run curl -s -o /dev/null -X POST -d "name=cp-orbit&path=/plugins" "$BASE/mkdir" || true
for f in "$@"; do
  if [ "${DRY_RUN:-}" = 1 ]; then
    echo "+ curl -X POST -F file=@$SRC/$f $BASE/upload?path=/plugins/cp-orbit&overwrite=1"
  else
    out=$(curl -s -w ' [HTTP %{http_code}]' -X POST -F "file=@$SRC/$f" "$BASE/upload?path=/plugins/cp-orbit&overwrite=1")
    echo "$f: $out"
    case "$out" in *"HTTP 200"*) ;; *) echo "upload failed: $f" >&2; exit 1 ;; esac
  fi
done
if [ "${DRY_RUN:-}" != 1 ]; then
  if curl -s "$BASE/api/plugins" | grep -q '"name":"cp-orbit"'; then
    echo "The reader lists cp-orbit."
  else
    echo "Uploaded, but /api/plugins does not list cp-orbit yet (Plugins setting off?)." >&2
  fi
fi
# CrossPoint 2.0.0 re-reads device.json and its event table when File Transfer ends; no restart.
echo "Leave File Transfer on the reader, and reload the Plugins web page to load the new card."
