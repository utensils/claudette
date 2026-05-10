# Boot-health gate — manual UAT

Companion to `scripts/smoke-boot-health-gate.sh` (which exercises the
helper subprocess against a synthetic install layout). This checklist
covers the pieces that need a real Tauri runtime, a real webview, and
a human eye on dialog rendering: the live probation timer, the boot
heartbeat, and the `show_pending_report` native dialog on next launch.

Issue context: GitHub issue 731 (utensils/claudette#731).

All paths below assume `~/Library/Application Support/claudette/` on
macOS, `$XDG_DATA_HOME/claudette/` on Linux, and `%APPDATA%/claudette/`
on Windows unless `CLAUDETTE_DATA_DIR` is set.

## Phase 0 — preconditions

1. Make sure no previous probation state will skew the test:

   ```bash
   APP_DATA="$(./target/debug/claudette-app --print-data-dir 2>/dev/null \
     || echo "$HOME/Library/Application Support/claudette")"
   rm -f "$APP_DATA/boot-probation.json" "$APP_DATA/boot-rollback-report.json"
   ```

2. Build the dev binary:

   ```bash
   cargo build -p claudette-tauri
   ```

3. Tail the daily log file in another terminal so you can observe the
   `claudette::updater` events as they fire:

   ```bash
   tail -F "$HOME/.claudette/logs/claudette.$(date -u +%Y-%m-%d).log" \
     | grep --line-buffered claudette::updater
   ```

## Phase 1 — healthy boot clears the sentinel

Verifies that a normal launch with a probation sentinel in place fires
`bootOk` once the React tree commits past the loader, the timer is
cancelled, and the sentinel is removed.

1. Hand-write a sentinel that mimics what `prepare_for_update` would
   leave on disk after an in-app update:

   ```bash
   cat > "$APP_DATA/boot-probation.json" <<EOF
   {
     "status": "pending",
     "failed_version": "9.9.9-test",
     "previous_version": "$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')",
     "download_url": "https://example.invalid/test.dmg",
     "install_kind": "unsupported",
     "target_path": "",
     "executable_path": "",
     "backup_path": null,
     "backup_error": null,
     "attempts": 0,
     "data_dir": "$APP_DATA",
     "created_at": "$(date -u -Iseconds)"
   }
   EOF
   ```

   `install_kind: unsupported` keeps the helper from doing anything
   destructive if Phase 1 fails — the rollback would degrade to a
   "report only" path because there's no real backup.

2. Launch the app:

   ```bash
   ./scripts/dev.sh
   ```

3. **Pass criteria:**
   - The app window paints normally (workspaces sidebar, etc.).
   - Within ~2 seconds of the UI hydrating, `boot-probation.json`
     disappears from `$APP_DATA`.
   - The log tail shows
     `claudette::updater  boot probation acknowledged by frontend`.
   - **No** native dialog appears.
   - **No** `boot-rollback-report.json` is written.

If the sentinel is still there after 15 seconds, the heartbeat path is
broken — open `App.tsx`'s `bootOk` useEffect and check that
`viewStateHydrated` flipped.

## Phase 2 — bounded retry on force-quit

Verifies that `MAX_PROBATION_ATTEMPTS` clears the sentinel once the
user has booted past the timer once (issue 731's "user-aborted boot"
case).

1. Re-create the same sentinel as Phase 1, but bump `attempts` to 1:

   ```bash
   sed -i.bak 's/"attempts": 0/"attempts": 1/' "$APP_DATA/boot-probation.json"
   rm -f "$APP_DATA/boot-probation.json.bak"
   ```

2. Launch the app:

   ```bash
   ./scripts/dev.sh
   ```

3. **Pass criteria:**
   - The sentinel is removed almost immediately at startup (before the
     React tree even mounts), via `start_monitor`'s threshold branch.
   - The log tail shows
     `boot probation cleared after reaching attempt threshold without a rollback`.
   - The heartbeat path still runs harmlessly — `bootOk` returns
     `Ok(())` because the sentinel is already gone.

## Phase 3 — timer fires and triggers rollback

This is the hard one because we deliberately want the React heartbeat
to NOT fire. The simplest reproduction:

1. Re-create a sentinel with `install_kind: linux_app_image` (or
   whatever your platform installs as) and a real `target_path` /
   `backup_path` pointing into a synthetic layout — same shape the
   automated smoke uses:

   ```bash
   TMP="$(mktemp -d)"
   mkdir -p "$TMP/install" "$TMP/backup"
   echo "broken" > "$TMP/install/marker"
   echo "restored" > "$TMP/backup/marker"
   cp ./target/debug/claudette-app "$TMP/install/claudette-app"
   chmod +x "$TMP/install/claudette-app"
   cp ./target/debug/claudette-app "$TMP/backup/claudette-app"
   chmod +x "$TMP/backup/claudette-app"

   cat > "$APP_DATA/boot-probation.json" <<EOF
   {
     "status": "pending",
     "failed_version": "9.9.9-test",
     "previous_version": "0.0.0-test-baseline",
     "download_url": "https://example.invalid/test.dmg",
     "install_kind": "linux_app_image",
     "target_path": "$TMP/install/claudette-app",
     "executable_path": "$TMP/install/claudette-app",
     "backup_path": "$TMP/backup/claudette-app",
     "backup_error": null,
     "attempts": 0,
     "data_dir": "$APP_DATA",
     "created_at": "$(date -u -Iseconds)"
   }
   EOF
   ```

2. Tighten the probation window to 2 seconds so you don't wait the
   default 10:

   ```bash
   export CLAUDETTE_BOOT_PROBATION_SECS=2
   ```

3. Disable the heartbeat. Easiest is a one-line patch to
   `src/ui/src/App.tsx` — comment out the `bootOk()` call inside the
   `viewStateHydrated` useEffect:

   ```diff
    useEffect(() => {
      if (!viewStateHydrated) return;
   -  bootOk().catch((err) => console.error("Failed to acknowledge boot:", err));
   +  // bootOk()  // intentionally disabled for Phase 3 UAT
    }, [viewStateHydrated]);
   ```

4. Launch the app:

   ```bash
   ./scripts/dev.sh
   ```

5. **Pass criteria:**
   - The window paints normally.
   - About 2 seconds in, the app exits abruptly (`app.exit(1)` after
     the timer fires).
   - The log tail shows the helper being spawned.
   - On the synthetic install, the helper restores the backup —
     `cat "$TMP/install/marker"` should now read `restored`.

6. Re-launch the app **without** any code change (heartbeat still
   disabled is fine — the sentinel is gone now):

   ```bash
   unset CLAUDETTE_BOOT_PROBATION_SECS
   ./scripts/dev.sh
   ```

7. **Pass criteria:**
   - A native macOS / GTK / Windows dialog appears titled *"Claudette
     update rolled back"* with the failed version 9.9.9-test and the
     baseline version 0.0.0-test-baseline.
   - After dismissing, the rest of the app boots normally.
   - `boot-rollback-report.json` is gone from `$APP_DATA` (the report
     is one-shot).

8. Restore the heartbeat patch in `App.tsx`.

## Phase 4 — show_pending_report failure dialog

Same shape as Phase 3 but for the *non*-restored path: the helper
couldn't replace the install (e.g. permission denied) and has to tell
the user to download manually.

1. Hand-write a failure report:

   ```bash
   cat > "$APP_DATA/boot-rollback-report.json" <<EOF
   {
     "failed_version": "9.9.9-test",
     "previous_version": "0.0.0-test-baseline",
     "download_url": "https://example.invalid/test.dmg",
     "restored": false,
     "error": "synthetic UAT failure"
   }
   EOF
   ```

2. Launch the app.

3. **Pass criteria:**
   - The dialog title is *"Claudette update rollback failed"*.
   - The body contains the URL `https://example.invalid/test.dmg`
     and the synthetic error message.
   - The report file is removed after the dialog dismisses.

## Phase 5 — backup pruning

Verifies that `prepare_for_update` cleans up older backup generations.
Requires triggering a real (or fake) update flow; this is the lowest
priority phase since it's covered by the
`create_backup_prunes_older_siblings` Rust unit test.

If you want to verify it live: drop a directory under
`~/.claudette/updates/previous/0.10.0` containing arbitrary content,
then trigger an update via Settings → About. After the update is
applied, only the newly-written generation should remain under
`~/.claudette/updates/previous/`.

## Cleanup

```bash
rm -rf "$APP_DATA/boot-probation.json" \
       "$APP_DATA/boot-rollback-report.json" \
       ~/.claudette/updates/previous \
       /tmp/claudette-boot-smoke.* 2>/dev/null
```
