#!/usr/bin/env bash
# Produce the JSON `cargo llvm-cov` report consumed by
# `scripts/check-coverage-interactive.sh` for the Claude Interactive
# patch-coverage gate. Runs the same package set as the existing CI
# coverage step (`claudette`, `claudette-server`, `claudette-cli`) so we
# inherit the same toolchain assumptions and don't pay for unrelated
# crates twice.
#
# See CLAUDE.md ("Build & test commands") and the interactive-claude
# coverage plan (Task A2) for context.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

output_path="${1:-target/llvm-cov-interactive.json}"
mkdir -p "$(dirname "$output_path")"

cargo llvm-cov \
  -p claudette -p claudette-server -p claudette-cli \
  --all-features \
  --json \
  --output-path "$output_path"

echo "wrote llvm-cov JSON: $output_path"
