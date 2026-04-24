#!/usr/bin/env bash
# latentforge-kickoff — creates a workspace in latentforge, enables plan mode,
# types a prompt, submits it. Records the whole interaction.
#
# Output: /tmp/claudette-capture/latentforge-kickoff.mov  (final concat happens
#         in demo-concat.sh — this step just produces the raw .mov)
# Exports:  LF_WORKSPACE_ID to a sibling file at /tmp/claudette-capture/lf-workspace-id
#
# Duration: ~20s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-kickoff"
WORKSPACE_NAME="vitepress-docs"

PROMPT="Implement a full VitePress documentation website for this project. Include: a polished landing page, a Getting Started guide, an Architecture overview, and an API reference generated from the code. Use the default VitePress theme with a project-appropriate primary color. Keep the build wired into the existing tooling. When implementation is complete, commit all changes with conventional-commit messages, push the branch to origin, and open a pull request on GitHub (gh pr create) with a clear title and a summary of what was added."

log "preflight"
window_require
window_activate
sleep 0.3

log "resetting to default-dark, closing settings"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  document.documentElement.setAttribute('data-theme', 'default-dark');
  s.setCurrentThemeId('default-dark');
  if (s.settingsOpen) s.closeSettings();
  s.setSidebarShowArchived(false);
  return 'ok';
"
sleep 0.6

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Brief dashboard hold
sleep 1.4

log "creating workspace 'vitepress-docs' in latentforge"
WS_ID_JSON=$(eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  const repo = s.repositories.find(r => r.name === 'latentforge');
  if (!repo) throw new Error('latentforge repo not found');
  const result = await window.__CLAUDETTE_INVOKE__('create_workspace', {
    repoId: repo.id,
    name: '$WORKSPACE_NAME',
    skipSetup: true,
  });
  // Refresh workspace list from backend so the new ws shows up in sidebar
  const loaded = await window.__CLAUDETTE_INVOKE__('load_initial_data');
  if (loaded && loaded.workspaces) s.setWorkspaces(loaded.workspaces);
  const ws = (loaded?.workspaces || s.workspaces).find(w => w.id === result.workspace.id);
  s.selectWorkspace(result.workspace.id);
  return { id: result.workspace.id, name: ws?.name, branch: ws?.branch_name };
")
echo "$WS_ID_JSON" | tee "$TMP_DIR/lf-workspace.json"
WS_ID=$(echo "$WS_ID_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

log "waiting for workspace UI to settle"
sleep 2.2

log "enabling plan mode"
eval_js "window.__CLAUDETTE_STORE__.getState().setPlanMode('$WS_ID', true); return 'ok';" >/dev/null
sleep 1.0

log "typing prompt"
# Pre-escape double quotes + backticks for JS template literal safety
ESCAPED_PROMPT=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")
eval_js "
  // Find the composer textarea. ChatPanel renders a <textarea>; pick the last
  // one since Settings etc. may have others.
  const areas = Array.from(document.querySelectorAll('textarea'));
  const ta = areas[areas.length - 1];
  if (!ta) throw new Error('no textarea found');
  await window.capture.typeInto('textarea:last-of-type', $ESCAPED_PROMPT, 18);
  return 'typed';
"
sleep 1.2

log "submitting prompt (planMode=true)"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  const wsId = '$WS_ID';
  s.updateWorkspace(wsId, { agent_status: 'Running' });
  s.clearUnreadCompletion(wsId);
  await window.__CLAUDETTE_INVOKE__('send_chat_message', {
    workspaceId: wsId,
    content: $ESCAPED_PROMPT,
    permissionLevel: null,
    model: null,
    fastMode: null,
    thinkingEnabled: null,
    planMode: true,
  });
  // Clear the composer so the UI looks clean after send
  const areas = Array.from(document.querySelectorAll('textarea'));
  const ta = areas[areas.length - 1];
  if (ta) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return 'sent';
"

# Record 6s of the agent kicking off (thinking indicator, early tokens)
sleep 6.0

record_stop "$NAME"

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
echo "$WS_ID" > "$TMP_DIR/lf-workspace-id"
log "workspace id saved to $TMP_DIR/lf-workspace-id"
