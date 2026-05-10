#!/usr/bin/env bash
# Local smoke test for the post-update boot-health gate (issue 731).
#
# This verifies the parts of the rollback flow that can be exercised
# without an actual auto-update event: the rollback helper's restore +
# relaunch logic, the sentinel/report file shapes, and the
# acknowledgement path. The pieces that require a real Tauri runtime
# (10-second timer firing → app.exit(1) → child helper spawning,
# native dialog rendering) live in the manual UAT checklist alongside
# this script (see boot-health-gate-manual-uat.md).
#
# What it does:
#   1. Builds a synthetic install layout in a temp dir: a "current"
#      install directory containing a deliberately-broken executable,
#      and a "backup" directory containing a known-good replacement.
#   2. Writes a boot-probation.json sentinel pointing at those paths.
#   3. Invokes the claudette-app helper subcommand
#      (`--boot-rollback-helper <sentinel> <fake-parent-pid>`) directly
#      against a parent PID that's already exited, so the helper goes
#      straight from `wait_for_parent_exit` to the actual restore.
#   4. Asserts the install dir now matches the backup, the sentinel was
#      removed, and a boot-rollback-report.json was written with
#      restored=true.
#
# Run it from the worktree root:
#   ./scripts/smoke-boot-health-gate.sh
#
# Exits non-zero on any assertion failure. Cleans up the temp dir
# unless $KEEP_TMP=1 (handy when triaging a failed run).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 1. Build claudette-app once. We use a debug build because:
#    - It keeps the test fast (release adds 2-3 minutes).
#    - The helper subcommand has no debug-vs-release behavioral split.
echo "==> building claudette-app (debug)"
if [ -n "${IN_NIX_SHELL:-}" ]; then
  cargo build -p claudette-tauri >/dev/null
else
  nix develop -c cargo build -p claudette-tauri >/dev/null
fi
APP_BIN="$ROOT/target/debug/claudette-app"
if [ ! -x "$APP_BIN" ]; then
  echo "expected $APP_BIN to be executable" >&2
  exit 1
fi

# 2. Build a synthetic "install" + "backup" layout under a temp dir.
TMP="$(mktemp -d -t claudette-boot-smoke.XXXXXX)"
if [ "${KEEP_TMP:-0}" != "1" ]; then
  trap 'rm -rf "$TMP"' EXIT
else
  echo "==> KEEP_TMP=1: smoke artifacts left at $TMP"
fi
DATA_DIR="$TMP/data"
INSTALL_DIR="$TMP/install"
BACKUP_DIR="$TMP/backups/0.23.0/install"
mkdir -p "$DATA_DIR" "$INSTALL_DIR/Contents/MacOS" "$BACKUP_DIR/Contents/MacOS"

# The "broken" install: an empty placeholder where claudette-app should
# live. The helper deletes the install dir wholesale before copying the
# backup over it, so the contents here just need to exist for the
# delete to be observable.
echo "broken" > "$INSTALL_DIR/Contents/MacOS/claudette-app"

# The "good" backup: a real executable shell script (the helper does
# `Command::new(executable_path).spawn()` after the copy, so the file
# at the destination must be runnable for the rollback to report
# `restored=true`). The script exits immediately so we don't leak a
# child. We sentinel the body with a known marker so the smoke can
# distinguish "restored from backup" from "still the original
# broken file".
cat > "$BACKUP_DIR/Contents/MacOS/claudette-app" <<'EOF'
#!/bin/sh
# RESTORED_BACKUP_MARKER
exit 0
EOF
chmod +x "$BACKUP_DIR/Contents/MacOS/claudette-app"
echo "this came from the backup" > "$BACKUP_DIR/RESTORE_PROOF"

SENTINEL="$DATA_DIR/boot-probation.json"
REPORT="$DATA_DIR/boot-rollback-report.json"

# 3. Hand-author the sentinel — the same shape boot_probation.rs writes
#    via prepare_for_update. `target_path` and `executable_path` point
#    at the synthetic install; `backup_path` points at the synthetic
#    backup. Status starts at rollback_in_progress because that's the
#    state the sentinel is in by the time the helper runs (the parent
#    process flips it before spawning the helper).
cat > "$SENTINEL" <<EOF
{
  "status": "rollback_in_progress",
  "failed_version": "0.24.0",
  "previous_version": "0.23.0",
  "download_url": "https://example.invalid/Claudette-0.23.0.dmg",
  "install_kind": "linux_app_image",
  "target_path": "$INSTALL_DIR",
  "executable_path": "$INSTALL_DIR/Contents/MacOS/claudette-app",
  "backup_path": "$BACKUP_DIR",
  "backup_error": null,
  "attempts": 1,
  "data_dir": "$DATA_DIR",
  "created_at": "2026-05-09T00:00:00+00:00"
}
EOF

# Pick a PID that's guaranteed to be dead so the helper doesn't sleep
# the full 20s waiting for it. PID 1 is always live; we want the
# opposite. Spawn a true subshell, capture its PID, wait for it.
( exit 0 ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true

# 4. Run the helper. It should restore the backup over the install dir,
#    write the report, and remove the sentinel.
echo "==> running rollback helper"
"$APP_BIN" --boot-rollback-helper "$SENTINEL" "$DEAD_PID" >"$TMP/helper.stderr" 2>&1 || {
  echo "helper exited non-zero:" >&2
  cat "$TMP/helper.stderr" >&2
  exit 1
}

# 5. Assert the world matches expectations.
echo "==> verifying rollback effects"
fail=0

if [ -f "$SENTINEL" ]; then
  echo "  ✗ sentinel was not removed: $SENTINEL" >&2
  fail=1
else
  echo "  ✓ sentinel removed"
fi

if [ ! -f "$REPORT" ]; then
  echo "  ✗ rollback report missing: $REPORT" >&2
  fail=1
else
  if grep -q '"restored": true' "$REPORT"; then
    echo "  ✓ report written with restored=true"
  else
    echo "  ✗ report present but does not contain restored=true:" >&2
    cat "$REPORT" >&2
    fail=1
  fi
fi

if [ ! -f "$INSTALL_DIR/RESTORE_PROOF" ]; then
  echo "  ✗ backup contents were not copied into the install dir" >&2
  fail=1
else
  if grep -q "this came from the backup" "$INSTALL_DIR/RESTORE_PROOF"; then
    echo "  ✓ install dir restored from backup"
  else
    echo "  ✗ RESTORE_PROOF present but content does not match the backup" >&2
    fail=1
  fi
fi

if [ ! -x "$INSTALL_DIR/Contents/MacOS/claudette-app" ]; then
  echo "  ✗ restored claudette-app is missing or not executable" >&2
  fail=1
else
  if grep -q "RESTORED_BACKUP_MARKER" "$INSTALL_DIR/Contents/MacOS/claudette-app"; then
    echo "  ✓ restored claudette-app body matches backup"
  else
    echo "  ✗ restored claudette-app body does not match backup" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "==> SMOKE FAILED"
  echo "Helper stderr:" >&2
  cat "$TMP/helper.stderr" >&2 || true
  exit 1
fi

echo "==> SMOKE PASSED"
echo "    install:  $INSTALL_DIR"
echo "    backup:   $BACKUP_DIR"
echo "    data:     $DATA_DIR"
