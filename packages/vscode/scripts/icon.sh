#!/bin/sh
# Draws the extension's icon, images/icon.png: a progress ring three quarters
# full with a pulse line across it, 128 x 128 as the Marketplace asks. No text
# and no third-party mark. Needs ImageMagick 7 (`magick`, or set MAGICK).
#
#   sh packages/vscode/scripts/icon.sh
#
# Metadata and timestamps are left out, so one ImageMagick writes the same
# bytes every time. The PNG is committed: packaging needs no ImageMagick.
set -eu
cd "$(dirname "$0")/.."
MAGICK="${MAGICK:-magick}"
mkdir -p images
"$MAGICK" -size 128x128 xc:none \
  -fill '#1e293b' -draw 'roundrectangle 0,0 127,127 26,26' \
  -fill none -strokewidth 11 \
  -stroke '#334155' -draw 'ellipse 64,64 41,41 0,360' \
  -stroke '#34d399' -draw 'stroke-linecap round ellipse 64,64 41,41 -90,180' \
  -stroke '#f8fafc' -strokewidth 6 \
  -draw 'stroke-linecap round stroke-linejoin round polyline 34,66 50,66 58,46 69,86 77,58 83,66 94,66' \
  -strip +set date:create +set date:modify -define png:exclude-chunks=date,time \
  PNG32:images/icon.png
echo 'wrote packages/vscode/images/icon.png'
