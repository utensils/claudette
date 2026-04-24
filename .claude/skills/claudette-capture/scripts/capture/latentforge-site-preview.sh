#!/usr/bin/env bash
# latentforge-site-preview — after the agent is done, start the VitePress
# dev server and navigate playwright-cli to capture screenshots at a few
# scroll positions. Stitches them into a short MP4.
#
# Output: /tmp/claudette-capture/latentforge-site-preview.mp4

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-site-preview"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"

log "resolving worktree path for workspace $WS_ID"
WORKTREE=$(eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  const ws = s.workspaces.find(w => w.id === '$WS_ID');
  return ws?.worktree_path || '';
" | tr -d '\n' | xargs)

if [[ -z "$WORKTREE" || ! -d "$WORKTREE" ]]; then
  echo "error: worktree path not found: $WORKTREE" >&2
  exit 1
fi
log "worktree: $WORKTREE"

# Find the dev command
DEV_CMD=""
DEV_CWD=""
for pkg in "$WORKTREE/docs/package.json" "$WORKTREE/package.json"; do
  if [[ -f "$pkg" ]]; then
    d=$(dirname "$pkg")
    if grep -q '"docs:dev"' "$pkg" 2>/dev/null; then
      DEV_CMD="docs:dev"; DEV_CWD="$d"; break
    elif grep -q '"dev"' "$pkg" 2>/dev/null; then
      DEV_CMD="dev"; DEV_CWD="$d"; break
    fi
  fi
done

if [[ -z "$DEV_CMD" ]]; then
  echo "error: no dev script" >&2
  exit 1
fi

log "starting dev server: (cd $DEV_CWD && pnpm run $DEV_CMD)"
DEV_LOG="$TMP_DIR/dev-server.log"
: > "$DEV_LOG"
nohup bash -c "cd '$DEV_CWD' && (pnpm run $DEV_CMD || npm run $DEV_CMD)" > "$DEV_LOG" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$TMP_DIR/dev-server.pid"
log "dev-server pid: $DEV_PID"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]]; then
    kill "$DEV_PID" 2>/dev/null || true
    sleep 0.5
    pkill -f "vitepress dev" 2>/dev/null || true
    pkill -f "node.*docs" 2>/dev/null || true
  fi
  playwright-cli close 2>/dev/null || true
}
trap cleanup EXIT

log "waiting for dev server URL…"
URL=""
for i in $(seq 1 90); do
  URL=$(grep -Eo 'http://localhost:[0-9]+(/[^ ]*)?' "$DEV_LOG" 2>/dev/null | head -1 || true)
  if [[ -n "$URL" ]]; then
    log "dev server up at $URL"
    break
  fi
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo "error: dev server didn't come up in 90s" >&2
  tail -40 "$DEV_LOG" >&2
  exit 1
fi

sleep 2  # vitepress initial build

log "capturing screenshots at 4 scroll positions"
SHOTS="$TMP_DIR/site-shots"
rm -rf "$SHOTS" && mkdir -p "$SHOTS"

playwright-cli close-all 2>/dev/null || true
playwright-cli open "$URL" >/dev/null 2>&1
playwright-cli resize 1920 1136 >/dev/null 2>&1 || true
sleep 1.8
playwright-cli screenshot --filename "$SHOTS/01-top.png" >/dev/null 2>&1

# Scroll via run-code (note: passes `page` to an async arrow fn)
playwright-cli run-code "async (page) => { await page.evaluate(() => window.scrollTo({top: 500, behavior: 'instant'})); await page.waitForTimeout(300); }" >/dev/null 2>&1
sleep 0.8
playwright-cli screenshot --filename "$SHOTS/02-scroll1.png" >/dev/null 2>&1

playwright-cli run-code "async (page) => { await page.evaluate(() => window.scrollTo({top: 1200, behavior: 'instant'})); await page.waitForTimeout(300); }" >/dev/null 2>&1
sleep 0.8
playwright-cli screenshot --filename "$SHOTS/03-scroll2.png" >/dev/null 2>&1

# Navigate to a docs subpage (Getting Started) for variety
playwright-cli run-code "async (page) => { const link = await page.\$('a[href*=\"getting-started\" i], a[href*=\"guide\"]'); if (link) await link.click(); await page.waitForTimeout(1500); }" >/dev/null 2>&1
sleep 1.0
playwright-cli screenshot --filename "$SHOTS/04-getting-started.png" >/dev/null 2>&1

playwright-cli close >/dev/null 2>&1 || true

log "verifying shots"
ls -lah "$SHOTS"

log "building MP4 from shots (2s each, Ken Burns scale)"
# Each shot held for 2s, crossfaded. Simplest: concat with xfade.
ffmpeg -y -hide_banner -loglevel warning \
  -loop 1 -t 2.2 -i "$SHOTS/01-top.png" \
  -loop 1 -t 2.2 -i "$SHOTS/02-scroll1.png" \
  -loop 1 -t 2.2 -i "$SHOTS/03-scroll2.png" \
  -loop 1 -t 2.2 -i "$SHOTS/04-getting-started.png" \
  -filter_complex "\
    [0:v]scale=1920:1136:force_original_aspect_ratio=increase,crop=1920:1136,setsar=1,fps=60[s0]; \
    [1:v]scale=1920:1136:force_original_aspect_ratio=increase,crop=1920:1136,setsar=1,fps=60[s1]; \
    [2:v]scale=1920:1136:force_original_aspect_ratio=increase,crop=1920:1136,setsar=1,fps=60[s2]; \
    [3:v]scale=1920:1136:force_original_aspect_ratio=increase,crop=1920:1136,setsar=1,fps=60[s3]; \
    [s0][s1]xfade=transition=fade:duration=0.3:offset=1.9[x01]; \
    [x01][s2]xfade=transition=fade:duration=0.3:offset=3.8[x02]; \
    [x02][s3]xfade=transition=fade:duration=0.3:offset=5.7[out]" \
  -map "[out]" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an \
  "$TMP_DIR/$NAME.mp4"

ls -lah "$TMP_DIR/$NAME.mp4"
