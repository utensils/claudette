#!/usr/bin/env bash
# Encode a captured .mov into MP4 (default) or GIF.
# Usage: encode_mp4 <mov_path> <out_path>
#        encode_gif <mov_path> <out_path>   (requires gifski)

set -euo pipefail

encode_mp4() {
  local in="$1"
  local out="$2"
  local width="${3:-1920}"
  # High-quality H.264: crf 18 ~ visually lossless; preset slow for better size.
  # +faststart moves moov atom to front so browsers can stream it.
  # yuv420p for max browser compatibility.
  # -an drops audio (screencapture has none but strip anyway).
  # Downscale to `width` (retina captures are 2x; web doesn't need 4K for a landing page).
  ffmpeg -y -hide_banner -loglevel warning \
    -i "$in" \
    -vf "scale=${width}:-2:flags=lanczos" \
    -c:v libx264 -preset slow -crf 18 \
    -pix_fmt yuv420p -movflags +faststart \
    -an \
    "$out"
}

encode_gif() {
  local in="$1"
  local out="$2"
  local fps="${3:-20}"
  local width="${4:-1440}"
  if ! command -v gifski >/dev/null 2>&1; then
    echo "error: gifski not found on PATH (brew install gifski)" >&2
    return 1
  fi
  # Extract frames via ffmpeg at reduced fps/width, pipe to gifski.
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  ffmpeg -y -hide_banner -loglevel warning \
    -i "$in" \
    -vf "fps=$fps,scale=$width:-1:flags=lanczos" \
    "$tmpdir/frame_%04d.png"
  gifski --fps "$fps" --width "$width" -o "$out" "$tmpdir"/frame_*.png
}
