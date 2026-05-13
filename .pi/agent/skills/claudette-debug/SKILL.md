---
name: claudette-debug
description: Debug the running Claudette Tauri dev app from pi by executing JavaScript in the webview, inspecting Zustand state, monitoring sessions, and taking screenshots. Use for Claudette UI/session debugging in this repo.
---

# Claudette Debug for pi

Use these scripts from the project root. They auto-discover the dev instance via `${TMPDIR:-/tmp}/claudette-dev/*.json` and fall back to port `19432`.

Set the skill directory explicitly when running scripts from pi:

```bash
CLAUDE_SKILL_DIR="$PWD/.pi/agent/skills/claudette-debug" \
  .pi/agent/skills/claudette-debug/scripts/debug-eval.sh 'return document.title'
```

## Rules

- Only works with a dev build. Do not launch the installed release app.
- If no dev app is running, ask the user to start `./scripts/dev.sh`.
- Use `debug-eval.sh` for store inspection and `debug-screenshot.sh` for screenshots.

## Common commands

```bash
# Status / identity
CLAUDE_SKILL_DIR="$PWD/.pi/agent/skills/claudette-debug" \
  .pi/agent/skills/claudette-debug/scripts/debug-eval.sh 'return document.title'

# Store overview
CLAUDE_SKILL_DIR="$PWD/.pi/agent/skills/claudette-debug" \
  .pi/agent/skills/claudette-debug/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return {
  selectedWorkspaceId: s.selectedWorkspaceId,
  selectedSessionIdByWorkspaceId: s.selectedSessionIdByWorkspaceId,
  workspaces: s.workspaces.map(w => ({ id: w.id, name: w.name, status: w.agent_status, worktree_path: w.worktree_path })),
  sessionsByWorkspace: Object.fromEntries(Object.entries(s.sessionsByWorkspace).map(([k, v]) => [k, v.map(x => ({ id: x.id, name: x.name, status: x.status, agent_status: x.agent_status }))])),
};
JS

# Screenshot
CLAUDE_SKILL_DIR="$PWD/.pi/agent/skills/claudette-debug" \
  .pi/agent/skills/claudette-debug/scripts/debug-screenshot.sh
```

See `reference/` for the fuller original recipes.
