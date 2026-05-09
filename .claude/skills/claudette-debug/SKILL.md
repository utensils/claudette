---
name: claudette-debug
description: Debug the running Claudette Tauri app by executing JavaScript in the webview and reading results back. Inspect Zustand store state, trace state changes, monitor sessions long-term, run end-to-end UAT, and diagnose UI bugs in real-time. Only works in dev builds.
when_to_use: Use when the user asks to inspect UI state, debug the webview, check what's on screen, monitor agent activity, take a screenshot of the app, or diagnose rendering/layout issues. Also use proactively after UI changes to verify they render correctly in the running app.
argument-hint: "[action] [args...]"
allowed-tools: Bash Read Grep Glob
---

# Claudette Debug

Execute JavaScript inside the running Claudette Tauri webview via a TCP debug server on `127.0.0.1`. Dev-build only (`#[cfg(debug_assertions)]`).

The server listens on port **19432 by default**, but the devshell `dev` helper auto-selects a free port (and writes a discovery file) so multiple dev instances can run in parallel against different branches. `debug-eval.sh` discovers the right instance automatically — you do not need to know the port. Details in [Port discovery](#port-discovery) below.

## Quick Start

```bash
/claudette-debug status                   # One-shot workspace status (agent, messages, scroll, tools)
/claudette-debug discover actions         # List all store functions with parameter names
/claudette-debug discover state           # List all state slices with types and values
/claudette-debug send "read README.md"    # Send a chat message to the active workspace
/claudette-debug wait                     # Block until agent goes idle (run_in_background)
/claudette-debug screenshot               # Capture screen, return image path for Read tool
/claudette-debug state                    # Contextual store overview
/claudette-debug eval 'return 1+1'        # Execute arbitrary JS
/claudette-debug monitor start            # Start background session monitor
```

## Prerequisites

- App running via the devshell `dev` helper (or `cargo tauri dev`) — debug TCP server starts automatically
- `python3` in PATH (used by eval helper)

**Do NOT launch the installed app.** Never run `osascript -e 'tell application "Claudette" to activate'`, `open -a Claudette`, or double-click `/Applications/Claudette.app`. The debug TCP server only exists in dev builds (gated by `#[cfg(debug_assertions)]`); the installed release build has no debug server and eval calls against it will fail or silently target the wrong process. If the dev build is not already running, ask the user to start `dev` — do not start it yourself and do not fall back to the installed app.

### Windows

The skill works on Windows via Git Bash (the `bash` shipped with Git for Windows / `MINGW64`). Invoke the same `scripts/*.sh` scripts; they detect MSYS via `uname -s` and dispatch to PowerShell-only paths where needed (e.g. `debug-screenshot.sh` → `debug-screenshot.ps1` for `System.Drawing`-based captures).

The dev entry point is `scripts/dev.ps1` (or the `dev` PowerShell profile function it ships with). It mirrors `dev.sh`'s discovery file at `$env:TEMP\claudette-dev\<pid>.json`, which Git Bash sees as `/tmp/claudette-dev/*.json` — so `debug-eval.sh`'s auto-discovery just works. `dev.ps1` runs the Tauri binary with `--no-default-features --features devtools,server,alternative-backends` (no `voice`, no `tauri/custom-protocol`) and binds Vite to `127.0.0.1` rather than `::1` — both are required to keep WebView2 happy and `__CLAUDETTE_INVOKE__` set; if you change either, the debug eval server will hang.

**Do NOT launch the MSI/NSIS-installed Claudette release** for the same reason as macOS: no debug server, so eval calls fail or silently target a different process. If the dev build is not running, ask the user to run `dev` from PowerShell.

## Port discovery

With the devshell `dev` helper, each dev instance probes for a free Vite port (starting at 1420) and a free debug port (starting at 19432), then writes `${TMPDIR:-/tmp}/claudette-dev/<pid>.json` with fields `{pid, debug_port, vite_port, cwd, branch, started_at}`. The file is removed on clean exit.

`debug-eval.sh` resolves the port in this order:
1. `$CLAUDETTE_DEBUG_PORT` (explicit override)
2. Live discovery file whose `cwd` is an ancestor of the current `$PWD` (matches the worktree you're running the command from)
3. The single live instance, if exactly one is running
4. Legacy default `19432`

If multiple instances are running and none match `$PWD`, the script exits with a list of `{pid, port, branch, cwd}` and asks the user to set `CLAUDETTE_DEBUG_PORT` or run from inside the target worktree. Stale files from crashed instances are cleaned up on access.

To force a specific instance: `CLAUDETTE_DEBUG_PORT=19433 debug-eval.sh '...'`.

## Scripts

All scripts live in `${CLAUDE_SKILL_DIR}/scripts/`:

| Script | Purpose |
|--------|---------|
| `scripts/debug-eval.sh` | Single-shot JS eval via TCP |
| `scripts/debug-monitor.sh` | Long-running session monitor (readable key names) |
| `scripts/debug-wait.sh` | Poll until agent idle, return summary JSON |
| `scripts/debug-screenshot.sh` | Cross-platform screenshot capture |

**IMPORTANT**: Always reference scripts via `${CLAUDE_SKILL_DIR}/scripts/` to ensure correct resolution regardless of working directory.

## Architecture

```
Terminal ──TCP:<port>──> debug server ──eval()──> webview JS context
                                                       |
Terminal <──TCP─────── debug server <──invoke── webview (result callback)
```

- **TCP server**: `src-tauri/src/commands/debug.rs` — wraps JS in async IIFE, evals in webview, 10s timeout
- **Port**: `19432` by default, overridable via `$CLAUDETTE_DEBUG_PORT` (set by the devshell `dev` helper per-instance)
- **Input cap**: 1 MB max per eval request

## Troubleshooting

Symptoms ↔ likely cause when something feels off:

- **Tauri command returns `"Command <name> not found"`** — the running binary predates the command's registration. `cargo tauri dev` only rebuilds the Rust binary on launch; webview reload (Cmd+R) does **not** trigger a rebuild. After backend changes, kill `cargo tauri dev` (Ctrl+C in its terminal) and re-run it.
- **`window.__CLAUDETTE_INVOKE__` / `__CLAUDETTE_STORE__` is `undefined`** — likely targeting the wrong process (see next bullet) or the React tree hasn't mounted yet (extremely rare).
- **`document.title` returns something other than "Claudette"** — `debug-eval.sh` connected to a different app's debug server. Multiple Tauri apps in this account use the same discovery directory and port range (Aethon uses 19433+, etc.). Sanity check the port → process binding:
  ```bash
  lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /:194[0-9]/'
  ```
  Then force the right port: `CLAUDETTE_DEBUG_PORT=<port> debug-eval.sh '...'`.
- **Discovery file points at a wrong/dead pid** — only the devshell `dev` helper writes `${TMPDIR}/claudette-dev/<pid>.json`. Plain `cargo tauri dev` doesn't, so its instance won't appear in discovery; `debug-eval.sh` falls back to legacy port `19432`. If a stale discovery file from a previous instance exists, it can mislead — `rm /tmp/claudette-dev/*.json` to clear.
- **Bundled-plugin file missing on disk after a code change** — the `BUNDLED_PLUGINS` slice is embedded via `include_str!` at compile time. Adding a plugin to the slice + restarting `cargo tauri dev` is the only way to seed it; the seed runs on app startup against `~/.claudette/plugins/`.

Quick identity check for any port:
```bash
CLAUDETTE_DEBUG_PORT=19432 debug-eval.sh 'return document.title'   # expect: "Claudette"
```

## How to Execute JS

JS must use `return` to send a value back:

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return document.title'
```

For multiline JS, use heredoc:
```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return s.workspaces.map(w => w.name);
JS
```

## Available Globals (dev mode only)

| Global | Type | Description |
|--------|------|-------------|
| `window.__CLAUDETTE_STORE__` | Zustand store | `.getState()` to read, `.subscribe()` to watch |
| `window.__CLAUDETTE_INVOKE__` | Tauri `invoke` | Call any Tauri command from eval'd JS |
| `window.__CLAUDETTE_CHAT_DEBUG__` | `boolean` | Toggle `[chat-debug]` console logging |

---

## Actions

`/claudette-debug [action] [args...]`

### `discover actions` — list all store functions with params

Runtime introspection — always reflects the current app, even after code changes.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return Object.entries(s)
  .filter(([, v]) => typeof v === 'function')
  .map(([name, fn]) => {
    const match = fn.toString().match(/^\(([^)]*)\)/);
    const params = match ? match[1].trim() : '';
    return name + '(' + params + ')';
  })
  .sort()
  .join('\n');
JS
```

### `discover commands` — show Tauri invoke commands

Read [reference/tauri-commands.md](reference/tauri-commands.md) for the complete list. Key commands for UAT:

- `sendChatMessage(workspaceId, content, permissionLevel?, model?, fastMode?, thinkingEnabled?, planMode?)`
- `createWorkspace(repoId, name)` -> CreateWorkspaceResult
- `loadInitialData()` -> repos, workspaces, branches
- `loadDiffFiles(workspaceId)` -> DiffFilesResult
- `stopAgent(workspaceId)`

### `discover state` — list all state slices

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return Object.entries(s)
  .filter(([, v]) => typeof v !== 'function')
  .map(([k, v]) => {
    const type = Array.isArray(v) ? 'array' : v instanceof Set ? 'Set' : v === null ? 'null' : typeof v;
    const size = Array.isArray(v) ? v.length : v instanceof Set ? v.size : v && typeof v === 'object' ? Object.keys(v).length : null;
    const sizeStr = size !== null ? ' (' + size + ')' : '';
    const preview = JSON.stringify(v, (_, val) => val instanceof Set ? [...val] : val);
    return k + ': ' + type + sizeStr + ' = ' + (preview || 'undefined').substring(0, 80);
  })
  .sort()
  .join('\n');
JS
```

### `status` — one-shot comprehensive status

Returns everything needed to assess the active workspace in a single eval.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
if (!wsId) return { error: 'no workspace selected' };
const ws = s.workspaces.find(w => w.id === wsId);
const msgs = s.chatMessages[wsId] || [];
const stream = s.streamingContent[wsId] || '';
const acts = s.toolActivities[wsId] || [];
const turns = s.completedTurns[wsId] || [];
const last = acts[acts.length - 1];
const c = document.querySelector('[class*="messages_"]');
const gap = c ? Math.round(c.scrollHeight - c.scrollTop - c.clientHeight) : -1;
const storeStatus = ws?.agent_status;
const isActive = storeStatus === 'Running' || stream.length > 0 || acts.length > 0 || (s.streamingThinking[wsId] || '').length > 0;
return {
  workspace: ws?.name,
  agentStatus: isActive ? 'Running' : storeStatus,
  messageCount: msgs.length,
  lastMessageRole: msgs[msgs.length - 1]?.role,
  streaming: stream.length > 0,
  streamingLength: stream.length,
  activeTools: acts.length,
  lastTool: last ? last.toolName + ': ' + (last.summary || '').substring(0, 60) : null,
  completedTurns: turns.length,
  scrollGap: gap,
  atBottom: gap >= 0 && gap < 50,
  pendingQuestion: !!s.agentQuestions[wsId],
  pendingPlanApproval: !!s.planApprovals[wsId],
  planMode: s.planMode[wsId] || false,
  fastMode: s.fastMode[wsId] || false,
  thinkingEnabled: s.thinkingEnabled[wsId] || false,
  showThinking: s.showThinkingBlocks[wsId] === true,
  thinkingLength: (s.streamingThinking[wsId] || '').length,
  effortLevel: s.effortLevel[wsId] || 'auto',
};
JS
```

### `send "message"` — send chat message to active workspace

Substitute `MESSAGE_TEXT_HERE` with the actual message. Escape backticks with `\``.

**Important**: This sets `agent_status` to `"Running"` in the store before invoking the
Tauri command. The normal UI path (ChatPanel) does this in React; since we bypass that
component, we must replicate it here so that `wait`, `monitor`, and `status` see the
correct state.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
if (!wsId) return 'ERROR: no workspace selected';
// After the multi-session refactor, send_chat_message is keyed on
// chat_session_id, not workspace_id. Resolve the active session from
// `selectedSessionIdByWorkspaceId` (set by the sidebar when a workspace
// becomes active). If absent, the first session in `sessionsByWorkspace`
// is the safe fallback — every workspace has at least one default session.
const sessionId = s.selectedSessionIdByWorkspaceId?.[wsId]
  ?? s.sessionsByWorkspace?.[wsId]?.[0]?.id;
if (!sessionId) return 'ERROR: no chat session for workspace';
const ws = s.workspaces.find(w => w.id === wsId);
if (ws?.agent_status === 'Running') return 'ERROR: agent already running';
s.updateWorkspace(wsId, { agent_status: 'Running' });
s.clearUnreadCompletion(wsId);
await window.__CLAUDETTE_INVOKE__('send_chat_message', {
  sessionId,
  messageId: null,
  content: `MESSAGE_TEXT_HERE`,
  mentionedFiles: null,
  permissionLevel: null,
  model: null,
  fastMode: null,
  thinkingEnabled: null,
  planMode: null,
  effort: null,
  chromeEnabled: null,
  disable1mContext: null,
  backendId: null,
  attachments: null,
});
return 'Sent to ' + ws.name;
JS
```

### `wait` — block until agent idle

Polls every 2s until done. **Must use `run_in_background: true`**.

```bash
# MUST use run_in_background: true
${CLAUDE_SKILL_DIR}/scripts/debug-wait.sh
```

Options: `--timeout N` (default 600s), `--interval N` (default 2s), `--workspace ID`

Returns: `{ running: false, agentStatus, messageCount, completedTurns, lastTurnTools, lastToolSummary, durationSeconds }`

### `screenshot` — capture screen for visual inspection

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-screenshot.sh
```

Returns image path. Use the Read tool to view it. Options: `--output PATH`

- **macOS**: `screencapture -x` (silent full-screen)
- **Linux/Wayland**: `grim`
- **Linux/X11**: `import -window root` or `scrot`

### `state` — contextual store overview

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const lines = [];
if (wsId) {
  const ws = s.workspaces.find(w => w.id === wsId);
  const msgs = s.chatMessages[wsId] || [];
  const stream = s.streamingContent[wsId] || '';
  const acts = s.toolActivities[wsId] || [];
  const turns = s.completedTurns[wsId] || [];
  const storeStatus = ws?.agent_status;
  const isActive = storeStatus === 'Running' || stream.length > 0 || acts.length > 0 || (s.streamingThinking[wsId] || '').length > 0;
  const effectiveStatus = isActive ? 'Running' : storeStatus;
  lines.push('=== Active: ' + ws?.name + ' (' + wsId.substring(0, 8) + ') ===');
  lines.push('  agentStatus: ' + effectiveStatus);
  lines.push('  messages: ' + msgs.length + (msgs.length > 0 ? ' (last: ' + msgs[msgs.length-1].role + ')' : ''));
  lines.push('  streaming: ' + (stream.length > 0 ? stream.length + ' chars' : 'false'));
  lines.push('  activeTools: ' + acts.length + (acts.length > 0 ? ' (last: ' + acts[acts.length-1].toolName + ')' : ''));
  lines.push('  completedTurns: ' + turns.length);
  lines.push('  planMode: ' + (s.planMode[wsId] || false));
  lines.push('  thinkingEnabled: ' + (s.thinkingEnabled[wsId] || false));
  lines.push('  showThinking: ' + (s.showThinkingBlocks[wsId] === true));
  lines.push('  thinkingLength: ' + (s.streamingThinking[wsId] || '').length);
  lines.push('  effortLevel: ' + (s.effortLevel[wsId] || 'auto'));
} else {
  lines.push('=== No workspace selected ===');
}
const others = s.workspaces.filter(w => w.id !== wsId);
if (others.length > 0) {
  lines.push('');
  lines.push('=== Other Workspaces ===');
  others.forEach(w => {
    const mc = (s.chatMessages[w.id] || []).length;
    lines.push('  ' + w.name + ': ' + w.agent_status + ', ' + mc + ' msgs');
  });
}
lines.push('');
lines.push('=== Global ===');
lines.push('  repositories: ' + s.repositories.length);
lines.push('  sidebar: ' + s.sidebarVisible + ', rightSidebar: ' + s.rightSidebarVisible);
lines.push('  terminal: ' + s.terminalPanelVisible);
lines.push('  diffFiles: ' + s.diffFiles.length);
lines.push('  theme: ' + s.currentThemeId);
return lines.join('\n');
JS
```

### `state <slice>` — dump specific slice

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.__CLAUDETTE_STORE__.getState().SLICE_NAME'
```

### `eval <js>` — arbitrary JS

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'USER_JS_HERE'
```

### `monitor start` — background session monitor

Run with `run_in_background: true`. Logs state changes with readable keys.

```bash
# MUST use run_in_background: true
${CLAUDE_SKILL_DIR}/scripts/debug-monitor.sh
```

Output keys: `toolCount`, `completedTurns`, `agentStatus`, `scrollGap`, `messageCount`, `lastToolSummary`, `inputJsonValid`, `streaming`, `thinking`, `thinkingEnabled`, `showThinking`, `effortLevel`

Options: `--expr 'JS'`, `--interval N`, `--max N`, `--logfile PATH`

### `monitor read` — tail monitor log

```bash
tail -50 /tmp/claudette-debug/monitor.log
```

### `watch <slice>` — subscribe to changes

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
window.__CLAUDETTE_DEBUG_UNSUB__?.();
window.__CLAUDETTE_DEBUG_UNSUB__ = window.__CLAUDETTE_STORE__.subscribe(
  (state, prev) => {
    if (state.SLICE_NAME !== prev.SLICE_NAME) {
      console.log('[debug] SLICE_NAME changed:', { prev: prev.SLICE_NAME, next: state.SLICE_NAME });
    }
  }
);
return 'Watching SLICE_NAME — check webview console';
JS
```

### `unwatch`

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
window.__CLAUDETTE_DEBUG_UNSUB__?.();
delete window.__CLAUDETTE_DEBUG_UNSUB__;
return 'All watchers removed';
JS
```

### `trace <action>` — monkey-patch store action

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const store = window.__CLAUDETTE_STORE__;
const orig = store.getState().ACTION_NAME;
if (typeof orig !== 'function') return 'ERROR: ACTION_NAME is not a function';
store.setState({
  ACTION_NAME: (...args) => {
    console.log('[debug] ACTION_NAME called:', args);
    return orig(...args);
  }
});
window.__CLAUDETTE_DEBUG_TRACED__ = window.__CLAUDETTE_DEBUG_TRACED__ || [];
window.__CLAUDETTE_DEBUG_TRACED__.push({ name: 'ACTION_NAME', orig });
return 'Tracing ACTION_NAME — check webview console';
JS
```

### `untrace`

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
(window.__CLAUDETTE_DEBUG_TRACED__ || []).forEach(({ name, orig }) => {
  window.__CLAUDETTE_STORE__.setState({ [name]: orig });
});
window.__CLAUDETTE_DEBUG_TRACED__ = [];
return 'All traces removed';
JS
```

### `hotkeys on` — lock hotkey badges visible for layout inspection

Overrides `setMetaKeyHeld` to ignore `false` — badges stay on through Cmd+Tab, blur, keypresses.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const store = window.__CLAUDETTE_STORE__;
const orig = store.getState().setMetaKeyHeld;
window.__META_ORIG__ = orig;
store.setState({ setMetaKeyHeld: (held) => { if (held) orig(held); } });
orig(true);
return 'Hotkey badges LOCKED on';
JS
```

### `hotkeys off` — unlock and hide hotkey badges

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const store = window.__CLAUDETTE_STORE__;
if (window.__META_ORIG__) {
  store.setState({ setMetaKeyHeld: window.__META_ORIG__ });
  window.__META_ORIG__(false);
  delete window.__META_ORIG__;
}
return 'Hotkey badges unlocked';
JS
```

### `maximize` — toggle window maximize for resize testing

Programmatically maximize the window, wait, then restore. Useful for testing resize flash behavior.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const { getCurrentWindow } = window.__TAURI__.window ?? await import("@tauri-apps/api/window");
const win = getCurrentWindow();
const wasMax = await win.isMaximized();
if (wasMax) {
  await win.unmaximize();
  return 'Window unmaximized';
} else {
  await win.maximize();
  return 'Window maximized';
}
JS
```

### `maximize-cycle` — maximize then restore after delay

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const { getCurrentWindow } = window.__TAURI__.window ?? await import("@tauri-apps/api/window");
const win = getCurrentWindow();
await win.maximize();
await new Promise(r => setTimeout(r, 1500));
await win.unmaximize();
return 'Maximize cycle complete';
JS
```

### `resize-info` — inspect native window/webview layer state

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const { getCurrentWindow } = window.__TAURI__.window ?? await import("@tauri-apps/api/window");
const win = getCurrentWindow();
const size = await win.innerSize();
const pos = await win.innerPosition();
const isMax = await win.isMaximized();
const isFull = await win.isFullscreen();
const scaleFactor = await win.scaleFactor();
const root = document.documentElement;
const body = document.body;
const rootBg = getComputedStyle(root).backgroundColor;
const bodyBg = getComputedStyle(body).backgroundColor;
return {
  windowSize: { width: size.width, height: size.height },
  position: { x: pos.x, y: pos.y },
  isMaximized: isMax,
  isFullscreen: isFull,
  scaleFactor,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
  rootBackground: rootBg,
  bodyBackground: bodyBg,
  htmlInlineStyle: root.style.cssText || '(none)',
};
JS
```

### `snapshot` — full store state dump

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const state = window.__CLAUDETTE_STORE__.getState();
return Object.fromEntries(
  Object.entries(state).filter(([, v]) => typeof v !== 'function')
);
JS
```

---

## Supporting Files

Detailed reference material in the `reference/` directory:

- **[reference/tauri-commands.md](reference/tauri-commands.md)** — All Tauri invoke commands with JS camelCase parameter names
- **[reference/store-actions.md](reference/store-actions.md)** — All Zustand store actions with parameters
- **[reference/recipes.md](reference/recipes.md)** — UAT verification recipes (tool summaries, doubled content, scroll, post-turn checks)
