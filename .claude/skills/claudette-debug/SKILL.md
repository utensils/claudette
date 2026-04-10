---
name: claudette-debug
description: Debug the running Claudette Tauri app by executing JavaScript in the webview and reading results back. Inspect Zustand store state, trace state changes, monitor sessions long-term, run end-to-end UAT, and diagnose UI bugs in real-time. Only works in dev builds (cargo tauri dev).
argument-hint: "[action] [target-or-js...]"
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# Claudette Debug

Execute JavaScript inside the running Claudette Tauri webview via a TCP debug server on `127.0.0.1:19432`. Dev-build only (`#[cfg(debug_assertions)]`).

## Quick Start

```bash
/claudette-debug state                    # Store overview (all slices)
/claudette-debug state completedTurns     # Dump a specific slice
/claudette-debug eval 'return 1+1'        # Execute arbitrary JS
/claudette-debug monitor start            # Start background session monitor
/claudette-debug monitor read             # Tail monitor log
/claudette-debug snapshot                 # Full store state dump
```

## Prerequisites

- App running via `cargo tauri dev` (debug TCP server starts automatically)
- Port 19432 available on localhost
- `python3` in PATH (used by eval helper)

## Scripts

Two helper scripts are bundled with this skill:

| Script | Purpose |
|--------|---------|
| `.claude/skills/claudette-debug/debug-eval.sh` | Single-shot JS eval via TCP |
| `.claude/skills/claudette-debug/debug-monitor.sh` | Long-running session monitor |

**IMPORTANT**: Always call scripts using paths relative to the project root. Never use absolute paths like `/Users/.../scripts/...`.

## Architecture

```
Terminal ──TCP:19432──> debug server ──eval()──> webview JS context
                                                      |
Terminal <──TCP────── debug server <──invoke── webview (result callback)
```

- **TCP server**: `src-tauri/src/commands/debug.rs` — listens on `127.0.0.1:19432`, wraps JS to capture return value, evals in webview, waits for result callback (10s timeout).
- **Round-trip**: Wrapped JS calls `window.__CLAUDETTE_INVOKE__('debug_eval_result', { requestId, data })` to send results back.
- **Input cap**: 1 MB max per eval request.

## How to Execute JS

JS must use `return` to send a value back:

```bash
.claude/skills/claudette-debug/debug-eval.sh 'return 1 + 1'
.claude/skills/claudette-debug/debug-eval.sh 'return document.title'
.claude/skills/claudette-debug/debug-eval.sh 'return window.__CLAUDETTE_STORE__.getState().workspaces.map(w => w.name)'
```

For multiline JS, use heredoc:
```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return Object.keys(s.completedTurns);
JS
```

## Available Globals (dev mode only)

| Global | Type | Description |
|--------|------|-------------|
| `window.__CLAUDETTE_STORE__` | Zustand `useAppStore` | `.getState()` to read, `.setState()` to write |
| `window.__CLAUDETTE_INVOKE__` | Tauri `invoke` function | Call any Tauri command from eval'd JS |
| `window.__CLAUDETTE_CHAT_DEBUG__` | `boolean` | Toggle `[chat-debug]` console logging |

## Actions

`/claudette-debug [action] [args...]`

| Action | Description |
|--------|-------------|
| `state` | Summary of all store slices (keys + sizes) |
| `state <slice>` | Dump a specific slice |
| `eval <js>` | Execute arbitrary JS and return the result |
| `monitor start` | Start background session monitor (writes to log file) |
| `monitor read` | Read last 50 lines of monitor log |
| `monitor read <N>` | Read last N lines of monitor log |
| `watch <slice>` | Subscribe to slice changes (logs to webview console) |
| `unwatch` | Remove all watch subscriptions |
| `trace <action>` | Monkey-patch a store action to log calls |
| `untrace` | Remove all traces |
| `snapshot` | Dump full store state as JSON |

---

## Action Implementations

### `state` — store overview

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
return Object.entries(s)
  .filter(([, v]) => typeof v !== 'function')
  .map(([k, v]) => {
    const size = Array.isArray(v) ? v.length
      : v && typeof v === 'object' ? Object.keys(v).length
      : String(v).length;
    return k + ': ' + (Array.isArray(v) ? '[' + size + ']' : typeof v === 'object' && v ? '{' + Object.keys(v).length + ' keys}' : JSON.stringify(v));
  }).join('\n');
JS
```

### `state <slice>` — dump specific slice

```bash
.claude/skills/claudette-debug/debug-eval.sh 'return window.__CLAUDETTE_STORE__.getState().SLICE_NAME'
```

### `eval <js>` — arbitrary JS

```bash
.claude/skills/claudette-debug/debug-eval.sh 'USER_JS_HERE'
```

### `snapshot` — full store state dump

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const state = window.__CLAUDETTE_STORE__.getState();
return Object.fromEntries(
  Object.entries(state).filter(([, v]) => typeof v !== 'function')
);
JS
```

### `monitor start` — background session monitor

Run the monitor script with `run_in_background: true`. This is **critical** — the monitor must run in the background so the user can interact with the app while it observes.

```bash
# MUST use run_in_background: true
.claude/skills/claudette-debug/debug-monitor.sh
```

The monitor:
- Polls the debug server every 1 second
- Only logs when state changes (deduplicates identical readings)
- Writes to both stdout and `/tmp/claudette-debug/monitor.log`
- Runs for up to 1 hour by default
- Tracks: tool activity count, completed turns, agent status, scroll gap, message count, last tool summary, JSON validity

**Custom expressions**: Pass `--expr` to monitor a specific JS expression instead of the default:

```bash
.claude/skills/claudette-debug/debug-monitor.sh --expr 'const c=document.querySelector("[class*=messages_]");return c?Math.round(c.scrollHeight-c.scrollTop-c.clientHeight):-1'
```

**Options**:

| Flag | Default | Description |
|------|---------|-------------|
| `--expr 'JS'` | comprehensive state | JS expression to evaluate each tick |
| `--interval N` | `1` | Seconds between polls |
| `--max N` | `3600` | Max iterations before auto-stop |
| `--logfile PATH` | `/tmp/claudette-debug/monitor.log` | Log file path |

### `monitor read` — tail monitor log

Read the log file directly. Default: last 50 lines.

```bash
tail -50 /tmp/claudette-debug/monitor.log
```

For more lines:

```bash
tail -200 /tmp/claudette-debug/monitor.log
```

### `watch <slice>` — subscribe to changes

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
window.__CLAUDETTE_DEBUG_UNSUB__?.();
window.__CLAUDETTE_DEBUG_UNSUB__ = window.__CLAUDETTE_STORE__.subscribe(
  (state, prev) => {
    if (state.SLICE_NAME !== prev.SLICE_NAME) {
      console.log('[debug] SLICE_NAME changed:', { prev: prev.SLICE_NAME, next: state.SLICE_NAME });
      console.trace('[debug] change origin');
    }
  }
);
return 'Watching SLICE_NAME — check webview console for changes';
JS
```

### `unwatch`

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
window.__CLAUDETTE_DEBUG_UNSUB__?.();
delete window.__CLAUDETTE_DEBUG_UNSUB__;
return 'All watchers removed';
JS
```

### `trace <action>` — monkey-patch store action

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const store = window.__CLAUDETTE_STORE__;
const orig = store.getState().ACTION_NAME;
if (typeof orig !== 'function') return 'ERROR: ACTION_NAME is not a function';
store.setState({
  ACTION_NAME: (...args) => {
    console.log('[debug] ACTION_NAME called:', args);
    console.trace('[debug] call origin');
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
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
(window.__CLAUDETTE_DEBUG_TRACED__ || []).forEach(({ name, orig }) => {
  window.__CLAUDETTE_STORE__.setState({ [name]: orig });
});
window.__CLAUDETTE_DEBUG_TRACED__ = [];
return 'All traces removed';
JS
```

---

## UAT Recipes

### Verify tool call summaries after a turn

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const turns = s.completedTurns[wsId] || [];
const t = turns[turns.length - 1];
if (!t) return 'no completed turns';
return {
  acts: t.activities.length,
  jsonAllValid: t.activities.every(a => { try { JSON.parse(a.inputJson); return true } catch { return false } }),
  summariesPresent: t.activities.filter(a => a.summary).length,
  samples: t.activities.slice(0, 5).map(a => a.toolName + ': ' + (a.summary || '(empty)')),
};
JS
```

### Verify no doubled streaming content

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const msgs = s.chatMessages[wsId] || [];
const doubled = msgs.filter(m => m.role === 'Assistant' && m.content.length > 40).find(m => {
  const q = Math.floor(m.content.length / 4);
  return m.content.substring(0, q) === m.content.substring(q, q * 2);
});
return doubled ? { doubled: true, preview: doubled.content.substring(0, 80) } : { doubled: false };
JS
```

### Check scroll position

```bash
.claude/skills/claudette-debug/debug-eval.sh <<'JS'
const c = document.querySelector('[class*="messages_"]');
if (!c) return 'no container';
return {
  atBottom: c.scrollHeight - c.scrollTop - c.clientHeight < 50,
  gap: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight),
};
JS
```

### Wait for turn completion then verify

```bash
# Run with run_in_background: true
for i in $(seq 1 600); do
  result=$(.claude/skills/claudette-debug/debug-eval.sh 'const s=window.__CLAUDETTE_STORE__.getState();const w=s.selectedWorkspaceId;const st=s.workspaces.find(x=>x.id===w)?.agent_status;if(st!=="Running"){const ct=(s.completedTurns[w]||[]).length;if(ct>0){const t=s.completedTurns[w][ct-1];return JSON.stringify({done:true,st,acts:t.activities.length,jsonOk:t.activities.every(a=>{try{JSON.parse(a.inputJson);return true}catch{return false}})})}return JSON.stringify({done:true,st,ct})}' 2>/dev/null)
  if [ -n "$result" ]; then echo "$result"; break; fi
done
```
