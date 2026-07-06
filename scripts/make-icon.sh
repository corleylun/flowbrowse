#!/usr/bin/env bash
# Regenerate build/icon.icns from assets/safecobrowser-icon.svg (macOS only: sips + iconutil).
set -euo pipefail
cd "$(dirname "$0")/.."

./node_modules/.bin/electron scripts/render-icon.js   # → build/icon-1024.png (1024², alpha)

SRC="build/icon-1024.png"
ICONSET="build/SafeCoBrowser.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
z() { sips -z "$1" "$1" "$SRC" --out "$ICONSET/$2" >/dev/null; }
z 16  icon_16x16.png
z 32  icon_16x16@2x.png
z 32  icon_32x32.png
z 64  icon_32x32@2x.png
z 128 icon_128x128.png
z 256 icon_128x128@2x.png
z 256 icon_256x256.png
z 512 icon_256x256@2x.png
z 512 icon_512x512.png
cp "$SRC" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o build/icon.icns
rm -rf "$ICONSET"
echo "built build/icon.icns"
