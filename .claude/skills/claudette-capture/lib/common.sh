#!/usr/bin/env bash
# Shared preamble sourced by every capture script.
# Expects to be sourced under bash.

set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "error: capture scripts require bash (not zsh/sh)" >&2
  exit 1
fi

CAPTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CAPTURE_DIR/../../.." && pwd)"
DEBUG_EVAL="$REPO_ROOT/.claude/skills/claudette-debug/scripts/debug-eval.sh"
UI_INPUT_JS="$CAPTURE_DIR/lib/ui-input.js"
OUT_DIR="$REPO_ROOT/site/src/assets/screenshots"
TMP_DIR="/tmp/claudette-capture"
mkdir -p "$OUT_DIR" "$TMP_DIR"

# shellcheck disable=SC1091
source "$CAPTURE_DIR/lib/window.sh"
# shellcheck disable=SC1091
source "$CAPTURE_DIR/lib/record.sh"
# shellcheck disable=SC1091
source "$CAPTURE_DIR/lib/encode.sh"

# eval helper — prepends ui-input.js shim so every eval has `window.capture` available
eval_js() {
  local body="$1"
  {
    cat "$UI_INPUT_JS"
    echo "$body"
  } | "$DEBUG_EVAL"
}

log() { printf "[capture] %s\n" "$*" >&2; }
