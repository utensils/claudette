#!/usr/bin/env bash
# Generate a contact sheet of every built-in theme applied to the running
# Claudette dev app. Captures just the Claudette window region (so it works
# even if focus slips to another app) and composes a labeled grid via
# ImageMagick's `magick montage`.
#
# Usage:
#   ./debug-contact-sheet.sh [--output PATH] [--tile 4x3] [--cell 640x350]
#
# Requirements:
#   - Claudette dev build running (`cargo tauri dev`) — debug TCP server on 19432
#   - macOS (uses osascript + screencapture -R). Linux TODO.
#   - ImageMagick `magick` in PATH (provided by devshell on macOS).
#
# Output: prints the contact-sheet path to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="/tmp/claudette-debug/contact"
OUTFILE=""
TILE="4x3"
CELL="640x350"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTFILE="$2"; shift 2 ;;
    --tile)   TILE="$2";    shift 2 ;;
    --cell)   CELL="$2";    shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: contact-sheet currently supports macOS only." >&2
  exit 1
fi

if ! command -v magick &>/dev/null; then
  echo "ERROR: ImageMagick (magick) not found. Add it to the devshell or install locally." >&2
  exit 1
fi

mkdir -p "$OUTDIR"
[[ -z "$OUTFILE" ]] && OUTFILE="${OUTDIR}/contact-sheet-$(date +%s).png"

# Resolve Claudette window bounds via AppleScript GUI scripting. Format: x,y,w,h
BOUNDS=$(osascript <<'AS'
tell application "System Events"
  tell process "claudette"
    set winPos to position of window 1
    set winSize to size of window 1
    return (item 1 of winPos as string) & "," & (item 2 of winPos as string) & "," & (item 1 of winSize as string) & "," & (item 2 of winSize as string)
  end tell
end tell
AS
)

if [[ -z "$BOUNDS" ]]; then
  echo "ERROR: couldn't find a Claudette window. Is the dev app running?" >&2
  exit 1
fi

# Bring Claudette to front so the screen capture contains app chrome (doesn't
# matter for the region capture, but makes overlapping windows disappear).
osascript -e 'tell application "System Events" to set frontmost of first process whose name is "claudette" to true' 2>/dev/null || true
sleep 0.4

# Theme list — order in the grid is left→right, top→bottom
THEMES=(
  default claudette linear velvet
  rose greenhouse solar gruvbox
  neon-tokyo bunker uplink-1984 phosphor-uplink
)

# Human-readable labels, same order
LABELS=(
  "Default" "Claudette" "Linear" "Velvet"
  "Rosé" "Greenhouse" "Solar" "Gruvbox"
  "Neon Tokyo" "Bunker" "Uplink 1984" "Phosphor Uplink"
)

FONT="/System/Library/Fonts/HelveticaNeue.ttc"

# Capture each theme
for theme in "${THEMES[@]}"; do
  "${SCRIPT_DIR}/debug-eval.sh" \
    "const mod = await import('/src/utils/theme.ts?t=' + Date.now()); const themes = await mod.loadAllThemes(); mod.applyTheme(mod.findTheme(themes, '$theme')); window.__CLAUDETTE_STORE__.getState().setCurrentThemeId('$theme'); return '$theme';" >/dev/null
  sleep 0.5
  screencapture -x -R "$BOUNDS" "${OUTDIR}/${theme}.png"
done

# Build the montage with per-cell labels
ARGS=()
for i in "${!THEMES[@]}"; do
  ARGS+=( \( "${OUTDIR}/${THEMES[$i]}.png" -set label "${LABELS[$i]}" \) )
done

magick montage "${ARGS[@]}" \
  -geometry "${CELL}+14+14" \
  -background '#0a0a0e' \
  -fill '#e4e4ef' \
  -font "$FONT" \
  -pointsize 22 \
  -tile "$TILE" \
  "$OUTFILE"

echo "$OUTFILE"
