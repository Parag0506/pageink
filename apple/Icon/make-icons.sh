#!/bin/bash
# Writes the app icon sources from the brand files in brand/, then renders the icon set and
# the in-app images. Needs rsvg-convert (librsvg) and ffmpeg.
#
# iOS and iPadOS: one 1024 px icon, full bleed on the page colour with no transparency and
# square corners (the system rounds them). Xcode makes the smaller sizes from it.
# macOS: the rounded square of the macOS icon grid (824 px on a 1024 px canvas, 100 px of
# padding for the shadow), on the page colour. At 16 and 32 px the small mark is used.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
brand="$here/../../brand"
assets="$here/../App/Assets.xcassets"
out="$assets/AppIcon.appiconset"
mkdir -p "$out"

page='#f8efdc'
fold='#e4cfa9'

# The drawing inside a brand SVG: everything between the svg element's lines, no title.
inner() { sed -e '1d' -e '$d' -e '/<title>/d' "$1"; }

# The mark centred on a square of the given side, scaled to the given share of it. The full
# mark's drawing runs from x 14 to 124 (the quill reaches right), so its centre is x 69.
placed() { # file side share
  local cx=64
  case "$1" in *pageink-mark.svg) cx=69 ;; esac
  awk -v side="$2" -v share="$3" -v cx="$cx" 'BEGIN { s = side * share / 128; o = (side - 128 * s) / 2;
    printf "<g transform=\"translate(%.2f %.2f) scale(%.4f)\">\n", o - (cx - 64) * s, o, s }'
  inner "$1"
  echo '</g>'
}

# iOS: the mark at 72 percent, so the "@" stays clear at 60 px on the home screen.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
  echo "<rect width=\"1024\" height=\"1024\" fill=\"$page\"/>"
  placed "$brand/pageink-mark.svg" 1024 0.72
  echo '</svg>'
} > "$here/icon.svg"

# macOS: the rounded square with a soft shadow and a fold coloured edge.
mac() { # mark file
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
  echo '<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">'
  echo '<feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#2f241c" flood-opacity="0.28"/></filter></defs>'
  echo "<rect x=\"100\" y=\"100\" width=\"824\" height=\"824\" rx=\"185\" fill=\"$page\" stroke=\"$fold\" stroke-width=\"4\" filter=\"url(#s)\"/>"
  echo '<g transform="translate(100 100)">'
  placed "$1" 824 0.74
  echo '</g>'
  echo '</svg>'
}
mac "$brand/pageink-mark.svg" > "$here/icon-mac.svg"
mac "$brand/pageink-mark-small.svg" > "$here/icon-mac-small.svg"

# The store refuses an iOS icon with an alpha channel, so the opaque render is written as RGB.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rsvg-convert -w 1024 -h 1024 -b "$page" "$here/icon.svg" -o "$tmp/icon.png"
ffmpeg -loglevel error -y -i "$tmp/icon.png" -pix_fmt rgb24 "$out/icon-1024.png"
for s in 16 32 128 256 512; do
  for k in 1 2; do
    px=$((s * k))
    src="$here/icon-mac.svg"
    [ "$px" -le 32 ] && src="$here/icon-mac-small.svg"
    name="mac-$s.png"
    [ "$k" = 2 ] && name="mac-$s@2x.png"
    rsvg-convert -w "$px" -h "$px" "$src" -o "$out/$name"
  done
done

# In-app images: the mark for the setup screen and the launch screen, and the wordmark.
cp "$brand/pageink-mark.svg" "$assets/Mark.imageset/mark.svg"
cp "$brand/pageink-logo.svg" "$assets/Wordmark.imageset/wordmark.svg"
cp "$brand/pageink-logo-dark.svg" "$assets/Wordmark.imageset/wordmark-dark.svg"
echo "Wrote the icon set and the in-app images."
