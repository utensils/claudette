#!/usr/bin/env bash
# Enforce the design-system rule: component CSS and TSX must reference
# tokens (`var(--*)`), never raw hex or rgb/rgba literals. The canonical
# token definitions live in src/styles/theme.css — that file is the only
# allowed source of raw color values.
#
# Allowed exceptions outside theme.css:
#   * `rgba(var(--*-rgb), <alpha>)` — the canonical pattern for layering
#     alpha over a token's RGB triplet.
#   * `&#NNNN;` HTML numeric entities in JSX/TSX (e.g. `&#9654;` ▶).
#
# Runs from src/ui. Exits non-zero with a report when violations are found.

set -euo pipefail

cd "$(dirname "$0")/.."

violations=0

# --- Rule 1: No hex colors outside theme.css ---
# Match #rgb / #rrggbb / #rrggbbaa. Exclude HTML numeric entities of the
# form `&#NNNN;` (these are decimal codepoints, not hex colors).
hex_hits=$(grep -rnE '#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b' src \
  --include='*.module.css' \
  --include='*.tsx' \
  --exclude-dir=node_modules \
  2>/dev/null | grep -vE '&#[0-9]+;' || true)

if [ -n "$hex_hits" ]; then
  echo "ERROR: hex color literals found outside theme.css:"
  echo "$hex_hits"
  violations=$((violations + 1))
fi

# --- Rule 2: No rgb/rgba literals outside theme.css ---
# Allow `rgba(var(--*-rgb), …)` — the canonical token-plus-alpha pattern.
rgba_hits=$(grep -rnE 'rgba?\(' src \
  --include='*.module.css' \
  --include='*.tsx' \
  --exclude-dir=node_modules \
  2>/dev/null | grep -vE 'rgba?\(\s*var\(--[a-z0-9-]+-rgb\)' || true)

if [ -n "$rgba_hits" ]; then
  echo "ERROR: rgb/rgba() literals found outside theme.css:"
  echo "$rgba_hits"
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Design-system check failed. Move tokens into src/styles/theme.css"
  echo "and reference them as var(--token-name) from component styles."
  exit 1
fi

echo "Design-system token check passed."
