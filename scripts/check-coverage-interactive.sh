#!/usr/bin/env bash
# Gate the Claude Interactive patch surface on `cargo llvm-cov` line coverage.
#
# This script parses the JSON produced by `scripts/coverage-interactive.sh`
# (or the equivalent CI step), filters down to the interactive-Claude file
# set, and computes an aggregate line-coverage percentage. The threshold is
# enforced when COVERAGE_GATE_BLOCKING=1 — otherwise the script reports the
# number, exits 0, and CI surfaces the value as informational.
#
# See CLAUDE.md ("Build & test commands") and the interactive-claude
# coverage plan (Task A2 + Task G1) for context.
set -euo pipefail

json_path="${1:-target/llvm-cov-interactive.json}"
threshold="${COVERAGE_GATE_THRESHOLD:-85}"
blocking="${COVERAGE_GATE_BLOCKING:-0}"

if [ ! -f "$json_path" ]; then
  echo "error: coverage JSON not found at $json_path" >&2
  echo "       run scripts/coverage-interactive.sh first" >&2
  exit 2
fi

# Files that make up the Claude Interactive patch surface. Keep this in
# sync with scripts/coverage-interactive.sh and the coverage plan.
patterns=(
  "src/agent/interactive_host/"
  "src/agent/interactive_protocol.rs"
  "src/agent/claude_interactive.rs"
  "src/interactive.rs"
  "src/db/interactive_sessions.rs"
  "src-session-host/src/"
  "src-tauri/src/commands/interactive.rs"
  "src-tauri/src/interactive_lifecycle.rs"
)

# Build a single jq expression of the form
#   (.filename | test("p1")) or (.filename | test("p2")) or ...
jq_filter=""
for p in "${patterns[@]}"; do
  # Escape regex meta-characters for jq's `test` (we treat each pattern as
  # a literal substring match). jq uses PCRE2 — `/` doesn't need escaping
  # and over-escaping it ("\/") raises an "Invalid escape" compile error.
  escaped="$(printf '%s' "$p" | sed -e 's/[][().|^$*+?{}\\]/\\&/g' -e 's/\./\\./g')"
  if [ -z "$jq_filter" ]; then
    jq_filter="(.filename | test(\"$escaped\"))"
  else
    jq_filter="$jq_filter or (.filename | test(\"$escaped\"))"
  fi
done

# Aggregate covered + total lines across the filtered files. We deliberately
# compute the ratio ourselves rather than averaging per-file percentages so
# a small fully-covered file can't drown out a large undertested one.
read -r covered total matched <<EOF
$(jq -r --argjson dummy 0 "
  [ .data[0].files[]
    | select($jq_filter)
    | {filename, covered: .summary.lines.covered, count: .summary.lines.count} ]
  | { covered: (map(.covered) | add // 0),
      total:   (map(.count)   | add // 0),
      matched: length }
  | \"\(.covered) \(.total) \(.matched)\"
" "$json_path")
EOF

if [ "${matched:-0}" -eq 0 ]; then
  echo "error: no interactive-claude files matched in $json_path" >&2
  echo "       check that the llvm-cov run included the right crates" >&2
  exit 2
fi

if [ "${total:-0}" -eq 0 ]; then
  echo "error: matched $matched file(s) but total line count is 0" >&2
  exit 2
fi

percent=$(awk -v c="$covered" -v t="$total" 'BEGIN { printf "%.2f", (c / t) * 100 }')

printf 'interactive patch coverage: %s%% (%s/%s lines across %s files, threshold=%s%%)\n' \
  "$percent" "$covered" "$total" "$matched" "$threshold"

# Per-file breakdown for diagnostic visibility (sorted lowest coverage first).
jq -r "
  .data[0].files[]
  | select($jq_filter)
  | [
      (.summary.lines.percent | tonumber | (. * 100 | round) / 100),
      .summary.lines.covered,
      .summary.lines.count,
      .filename
    ]
  | @tsv
" "$json_path" \
  | sort -n \
  | awk -F '\t' '{ printf "  %6.2f%%  %4d/%4d  %s\n", $1, $2, $3, $4 }'

if awk -v p="$percent" -v t="$threshold" 'BEGIN { exit (p + 0 < t + 0) ? 0 : 1 }'; then
  if [ "$blocking" = "1" ]; then
    echo "error: interactive patch coverage ${percent}% < ${threshold}% threshold" >&2
    exit 1
  else
    echo "warn: interactive patch coverage ${percent}% < ${threshold}% threshold (informational; set COVERAGE_GATE_BLOCKING=1 to enforce)" >&2
  fi
fi
