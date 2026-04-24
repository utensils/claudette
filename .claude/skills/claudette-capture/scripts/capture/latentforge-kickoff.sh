#!/usr/bin/env bash
# latentforge-kickoff — creates a workspace in latentforge, enables plan mode,
# types a prompt, clicks the Send button (natural flow, input clears).
#
# Output: /tmp/claudette-capture/latentforge-kickoff.mp4
# Exports: $TMP_DIR/lf-workspace-id  with the new workspace UUID
# Duration: ~26s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-kickoff"
WORKSPACE_NAME="${WORKSPACE_NAME:-demo-$(date +%H%M)}"

PROMPT="Build a polished VitePress docs site for this project: landing page, Getting Started guide, and an auto-generated MCP tools reference. Add a 'docs-dev' helper in the Nix devshell for hot reload, then commit, push, and open a PR."

log "preflight"
window_require
window_activate
sleep 0.3

log "resetting UI to clean default-dark state"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  document.documentElement.setAttribute('data-theme', 'default-dark');
  s.setCurrentThemeId('default-dark');
  if (s.settingsOpen) s.closeSettings();
  s.setSidebarShowArchived(false);
  window.__CLAUDETTE_STORE__.setState({ terminalPanelVisible: false });
  s.selectWorkspace(null);
  return 'ok';
"
sleep 0.6

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Brief hold on dashboard
sleep 1.4

log "creating workspace '$WORKSPACE_NAME' in latentforge"
WS_ID_JSON=$(eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  const repo = s.repositories.find(r => r.name === 'latentforge');
  if (!repo) throw new Error('latentforge repo not found');
  const result = await window.__CLAUDETTE_INVOKE__('create_workspace', {
    repoId: repo.id,
    name: '$WORKSPACE_NAME',
    skipSetup: true,
  });
  const loaded = await window.__CLAUDETTE_INVOKE__('load_initial_data');
  if (loaded && loaded.workspaces) s.setWorkspaces(loaded.workspaces);
  s.selectWorkspace(result.workspace.id);
  const ws = s.workspaces.find(w => w.id === result.workspace.id);
  return { id: result.workspace.id, name: ws?.name, branch: ws?.branch_name };
")
echo "$WS_ID_JSON" | tee "$TMP_DIR/lf-workspace.json"
WS_ID=$(echo "$WS_ID_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

log "waiting for workspace UI to settle"
sleep 2.2

log "enabling plan mode"
eval_js "window.__CLAUDETTE_STORE__.getState().setPlanMode('$WS_ID', true); return 'ok';" >/dev/null
sleep 1.0

log "typing prompt (faster chunks + 10ms per char for smoother capture)"
ESCAPED_PROMPT=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")
# Type in chunks so we stay under the 10s eval timeout. typeInto streams
# character-by-character inside a single eval; split the prompt in halves.
CHUNK_SIZE=350
python3 - "$PROMPT" "$CHUNK_SIZE" >"$TMP_DIR/prompt-chunks.json" <<'PY'
import json, sys
text, n = sys.argv[1], int(sys.argv[2])
chunks = [text[i:i+n] for i in range(0, len(text), n)]
json.dump(chunks, sys.stdout)
PY

# First chunk clears then types; subsequent chunks append.
first_chunk=$(python3 -c "import json; print(json.dumps(json.load(open('$TMP_DIR/prompt-chunks.json'))[0]))")
eval_js "
  const areas = Array.from(document.querySelectorAll('textarea'));
  const ta = areas[areas.length - 1];
  if (!ta) throw new Error('no textarea found');
  ta.focus();
  // Clear first
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // Stream first chunk
  let cur = '';
  for (const ch of $first_chunk) {
    cur += ch;
    setter.call(ta, cur);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 9));
  }
  return 'chunk1 done';
" >/dev/null

# Remaining chunks: append to existing value
chunk_count=$(python3 -c "import json; print(len(json.load(open('$TMP_DIR/prompt-chunks.json'))))")
for i in $(seq 1 $((chunk_count - 1))); do
  chunk=$(python3 -c "import json; print(json.dumps(json.load(open('$TMP_DIR/prompt-chunks.json'))[$i]))")
  eval_js "
    const areas = Array.from(document.querySelectorAll('textarea'));
    const ta = areas[areas.length - 1];
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
    let cur = ta.value;
    for (const ch of $chunk) {
      cur += ch;
      setter.call(ta, cur);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 9));
    }
    return 'chunk$i done';
  " >/dev/null
done
sleep 0.8

log "clicking Send button"
eval_js "
  const btn = document.querySelector('button[aria-label=\"Send message\"]');
  if (!btn) throw new Error('Send button not found');
  btn.click();
  return 'clicked';
" >/dev/null

# Record 7s of the agent kicking off (thinking indicator + plan agent spawning)
sleep 7.0

record_stop "$NAME"

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
echo "$WS_ID" > "$TMP_DIR/lf-workspace-id"
log "workspace id saved to $TMP_DIR/lf-workspace-id"
