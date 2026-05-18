#!/usr/bin/env bash
# Produce the JSON `cargo llvm-cov` report consumed by
# `scripts/check-coverage-interactive.sh` for the Claude Interactive
# patch-coverage gate.
#
# Crate set:
#   - `claudette`         — the lib that owns the bulk of the interactive
#                           surface (claude_interactive.rs, interactive.rs,
#                           interactive_host/*, interactive_protocol.rs,
#                           db/interactive_sessions.rs).
#   - `claudette-server`  — pulled in for parity with the existing CI
#                           coverage step. No interactive files live here
#                           today but the package set must match so the
#                           toolchain assumptions stay consistent.
#   - `claudette-cli`     — same rationale.
#   - `claudette-session-host` — owns the sidecar host side of the
#                           interactive protocol (server.rs, session.rs,
#                           idle.rs). Its clippy IS in CI per CLAUDE.md.
#
# Notably NOT included: `claudette-tauri`. Per CLAUDE.md it requires
# system libs not installed on the Linux CI runner, so we can't run its
# tests under llvm-cov in CI. The interactive command wrappers in
# `src-tauri/src/commands/interactive.rs` + `interactive_lifecycle.rs`
# are tested locally per the dev-machine checklist and excluded from the
# gate. See `scripts/check-coverage-interactive.sh` for the file
# filtering and the documented per-file exclusions.
#
# See CLAUDE.md ("Build & test commands") and the interactive-claude
# coverage plan (Task A2 + Task G1) for context.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

output_path="${1:-target/llvm-cov-interactive.json}"
mkdir -p "$(dirname "$output_path")"

cargo llvm-cov \
  -p claudette -p claudette-server -p claudette-cli -p claudette-session-host \
  --all-features \
  --json \
  --output-path "$output_path"

echo "wrote llvm-cov JSON: $output_path"
