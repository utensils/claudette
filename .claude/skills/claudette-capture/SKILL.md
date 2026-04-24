---
name: claudette-capture
description: Drive the running Claudette Tauri app through scripted UI flows and record deterministic marketing screenshots + MP4s for utensils.io/claudette. Dev-build only. Each capture is a canned flow that seeds store state, drives synthetic input, and pairs with a window-targeted screen recorder.
when_to_use: Use when producing or refreshing the site's product imagery for issue #288, or when adding a new per-asset capture script. Not for ad-hoc debugging — use the sibling `claudette-debug` skill for that.
argument-hint: "<capture-name> | list"
allowed-tools: Bash Read Write Edit
---

# Claudette Capture

Automated capture pipeline for the utensils.io/claudette landing page. Each asset has one script under `scripts/capture/<name>.sh` that:

1. Asserts the dev build is running (reuses `claudette-debug`'s port-discovery contract)
2. Focuses and resizes the Tauri window to a canonical size
3. Seeds deterministic store state via `__CLAUDETTE_STORE__.setState()`
4. Starts `screencapture -v -l <windowId>` (window-scoped, no desktop leakage)
5. Drives synthetic input (typing, clicking, store actions)
6. Stops the recorder (SIGINT to flush the MOV)
7. Encodes final output with `ffmpeg` (MP4) or leaves the raw PNG for stills
8. Drops the artefact in `site/src/assets/screenshots/<name>.{png,mp4}`

## Prerequisites

- **Dev build running** via `cargo tauri dev` or the devshell `dev` helper — the debug TCP eval server only exists in dev builds
- **macOS** — canonical platform for marketing assets (Linux/Windows parity is a follow-up)
- `ffmpeg` on PATH (from nixpkgs / Homebrew)
- Optional: `gifski` for GIF fallback encodes (`--gif` flag on `lib/encode.sh`)

**Do not launch the installed release app.** `#[cfg(debug_assertions)]` gates the eval server; a release build has none and scripts will hang on port probe.

## Usage

```bash
# List all capture scripts
.claude/skills/claudette-capture/scripts/list.sh

# Run a single capture (relative to repo root)
.claude/skills/claudette-capture/scripts/capture/hero.sh
.claude/skills/claudette-capture/scripts/capture/theme-cycle.sh
```

Each script is idempotent — re-running overwrites the output. Partial failures clean up stale recorder PIDs in `/tmp/claudette-capture/`.

## Layout

```
lib/
  ui-input.js     — React-safe typing/clicking/state seed helpers (loaded into eval payloads)
  window.sh       — AppleScript: activate + resize + return windowId
  record.sh       — screencapture -v wrapper (start/stop/wait)
  encode.sh       — ffmpeg MP4 + optional gifski GIF
scripts/
  list.sh         — enumerate all capture scripts with descriptions
  capture/        — one .sh per site asset
    hero.sh              — 1a  hero still
    pr-status.sh         — 2c  PR/CI status still
    remote.sh            — 2d  Remote workspaces still
    diff-still.sh        — 2f  Diff viewer still
    theme-cycle.sh       — 2g  Theme cycling MP4
    diff-scroll.sh       — 2f  Diff scroll MP4
reference/
  eval-port.md    — how port discovery is reused from claudette-debug
CAPTURE_GUIDE.md  — table of 13 planned assets, state seed, driven actions, status
```

## Authoring a new capture

1. Pick an asset from `CAPTURE_GUIDE.md`; add or update its row
2. Copy `scripts/capture/hero.sh` as a template for stills or `theme-cycle.sh` for motion
3. Source `lib/window.sh` + `lib/record.sh` + `lib/encode.sh`
4. Load `lib/ui-input.js` into your eval payload via `SHIM="$(cat $LIB/ui-input.js)"`
5. Document canonical window size, theme, and expected output size in a comment block at the top of the script

## Related skills

- **`claudette-debug`** — sibling skill for interactive debugging. Shares the TCP eval port-discovery contract. Capture scripts reuse its `scripts/debug-eval.sh` directly.
