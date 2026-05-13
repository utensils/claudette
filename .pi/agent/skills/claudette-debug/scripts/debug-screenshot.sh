#!/usr/bin/env bash
# Cross-platform screenshot capture for visual inspection.
# Usage: ./debug-screenshot.sh [--output PATH]
#
# macOS:         screencapture -x (silent full-screen)
# Linux/Wayland: grim
# Linux/X11:     import -window root (ImageMagick) or scrot
# Windows:       PowerShell + System.Drawing (no extra deps).
#                Detected by `uname -s` matching MINGW/MSYS/CYGWIN —
#                this script only runs from Git Bash / MSYS shells on
#                Windows; native PowerShell users invoke debug-screenshot.ps1
#                directly.
#
# Prints the output file path to stdout so Claude can Read the image.
set -euo pipefail

OUTDIR="/tmp/claudette-debug"
OUTFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTFILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUTDIR"

if [[ -z "$OUTFILE" ]]; then
  OUTFILE="${OUTDIR}/screenshot-$(date +%s).png"
fi

case "$(uname -s)" in
  Darwin)
    screencapture -x "$OUTFILE"
    ;;
  Linux)
    if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
      if command -v grim &>/dev/null; then
        grim "$OUTFILE"
      else
        echo "ERROR: grim not found. Install grim for Wayland screenshots." >&2
        exit 1
      fi
    else
      if command -v import &>/dev/null; then
        import -window root "$OUTFILE"
      elif command -v scrot &>/dev/null; then
        scrot "$OUTFILE"
      else
        echo "ERROR: No screenshot tool found. Install ImageMagick (import) or scrot." >&2
        exit 1
      fi
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Translate the MSYS path (`/c/Users/...`) to a native Windows path
    # (`C:\Users\...`) before handing it to PowerShell — PowerShell's
    # File.SaveAs treats `/c/...` as a relative path and fails. cygpath
    # is bundled with Git for Windows / MSYS / Cygwin.
    if command -v cygpath >/dev/null 2>&1; then
      WINPATH=$(cygpath -w "$OUTFILE")
    else
      WINPATH="$OUTFILE"
    fi
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if command -v cygpath >/dev/null 2>&1; then
      PS1_PATH=$(cygpath -w "${SCRIPT_DIR}/debug-screenshot.ps1")
    else
      PS1_PATH="${SCRIPT_DIR}/debug-screenshot.ps1"
    fi
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass \
        -File "$PS1_PATH" --output "$WINPATH" >/dev/null
    ;;
  *)
    echo "ERROR: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

echo "$OUTFILE"
