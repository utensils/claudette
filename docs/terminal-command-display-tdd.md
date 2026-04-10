# Technical Design: Terminal Command Display in Sidebar

**Status**: Draft
**Date**: 2026-04-10
**Issue**: [#121](https://github.com/utensils/Claudette/issues/121)

## 1. Overview

Show the currently running terminal command for each workspace in the sidebar, allowing users to see at a glance which workspaces have active development servers or persistent processes running.

### User Stories

- As a developer, I want to see which workspaces have running processes (like `npm run dev` or `rails server`) so I can quickly identify active environments without switching between workspaces
- As a developer, I want to see the command name in the sidebar so I know what's running without opening the terminal panel
- As a developer, I want the indicator to update when I start/stop processes so the information stays current

## 2. Current Architecture

### Terminal Flow

```
User opens terminal tab
  → TerminalPanel calls spawnPty(worktreePath) → Tauri command
  → Rust spawns PTY via portable_pty, starts background reader thread
  → User types command → term.onData() → writePty(ptyId, bytes) → Rust writes to PTY
```

### Key Components

| Component | File | Current State |
|-----------|------|---------------|
| PTY handle | `src-tauri/src/state.rs` | Tracks writer, master, child process |
| Terminal tabs | `src/model/terminal_tab.rs` | Stores id, workspace_id, title, is_script_output |
| Sidebar display | `src/ui/src/components/sidebar/Sidebar.tsx` | Shows workspace name, branch, status dot |
| Store | `src/ui/src/stores/useAppStore.ts` | Manages terminal tabs per workspace |

### Gap Analysis

1. **No command tracking**: PTY only tracks the shell process, not what command is running inside it
2. **No UI display**: Sidebar doesn't have a slot for showing terminal command information
3. **No state synchronization**: No mechanism to update workspace state when a command starts/ends

## 3. Design

### 3.1 Approach: Input Tracking

Track the last command line submitted to each PTY by monitoring input sent to `write_pty`:

**Why input tracking?**
- ✅ Shell-agnostic (works with bash, zsh, fish)
- ✅ No process introspection needed (avoids platform-specific code)
- ✅ Lightweight (no polling, no external tools)
- ✅ Captures user intent (what they typed)
- ❌ Doesn't detect when process exits (limitation accepted)
- ❌ False positives for `cd`, `ls` (mitigated by UI design)

**Alternatives considered:**
1. **Process introspection** (`ps`, `/proc`) - fragile, platform-specific, requires polling
2. **Shell output parsing** - unreliable (PS1 variations, ncurses apps)
3. **Shell integration** - requires user shell config changes

### 3.2 Command Extraction Logic

When `write_pty` receives data:

**On newline detected** (`\n` or `\r`):
1. Buffer all input since last newline
2. On newline detected:
   - Trim whitespace
   - Ignore if empty, starts with `#`, or is a builtin (cd, ls, pwd, etc.)
   - Extract command name (first word)
   - Store as "last command" for this PTY
   - Emit `pty-command-detected` event

**On Ctrl+C detected** (`\x03` byte):
1. Clear the `last_command` for this PTY
2. Emit `pty-command-stopped` event with `{ pty_id, command: null }`

**Builtin ignore list**: `cd`, `ls`, `pwd`, `echo`, `export`, `alias`, `history`, `clear`, `exit`

**Examples**:
- Input: `npm run dev\n` → Stores `"npm run dev"`, emits event
- Input: `cd src\n` → Ignored (builtin)
- Input: `\x03` (Ctrl+C) → Clears command, emits stopped event
- Input: `rails server -p 3000\n` → Stores `"rails server -p 3000"`

### 3.3 Data Model Changes

#### Backend: PTY Handle Enhancement

**File**: `src-tauri/src/state.rs`

```rust
pub struct PtyHandle {
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,
    /// Buffer for accumulating input until newline
    pub input_buffer: Mutex<Vec<u8>>,
    /// The last command submitted (for display purposes)
    pub last_command: Mutex<Option<String>>,
}
```

#### Backend: New Tauri Command

**File**: `src-tauri/src/pty.rs`

```rust
#[derive(Serialize)]
pub struct PtyInfo {
    pub pty_id: u64,
    pub last_command: Option<String>,
}

#[tauri::command]
pub async fn get_pty_info(
    pty_id: u64,
    state: State<'_, AppState>,
) -> Result<PtyInfo, String>
```

Returns the last command for a given PTY ID.

#### Frontend: Workspace Display State

**File**: `src/ui/src/stores/useAppStore.ts`

```typescript
interface AppStore {
  // ... existing fields ...

  /// Map of workspace_id → last active terminal command
  workspaceTerminalCommands: Record<string, string | null>;

  /// Update the terminal command for a workspace
  setWorkspaceTerminalCommand: (wsId: string, command: string | null) => void;
}
```

### 3.4 Implementation Flow

```
1. User types "npm run dev" + Enter in terminal
   ↓
2. TerminalPanel.onData() → writePty(ptyId, bytes)
   ↓
3. write_pty detects \n in bytes
   ↓
4. Extracts command from input_buffer
   ↓
5. Stores in last_command (if not a builtin)
   ↓
6. Emits Tauri event: "pty-command-detected" { pty_id, command }
   ↓
7. Frontend listener receives event
   ↓
8. Looks up workspace_id for this pty_id (via terminalTabs)
   ↓
9. Calls setWorkspaceTerminalCommand(wsId, command)
   ↓
10. Sidebar reactively updates to show command
```

### 3.5 UI Design

#### Sidebar Workspace Item

**Current layout:**
```
[●] workspace-name
    claudette/workspace-name
```

**New layout with command:**
```
[●] workspace-name
    claudette/workspace-name
    ▸ npm run dev
```

**Visual treatment:**
- Font: monospace, 11px, muted color (`--text-tertiary`)
- Icon: ▸ (triangular play symbol) to indicate active process
- Placement: Below branch name, same indentation level
- Max width: Truncate long commands with ellipsis (e.g., `npm run dev --port 3000...`)
- Only show if command exists

**CSS** (`Sidebar.module.css`):
```css
.terminalCommand {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminalCommandIcon {
  margin-right: 4px;
  opacity: 0.7;
}
```

### 3.6 Event Handling

**New Tauri events**:

1. **`pty-command-detected`**: Emitted when a command is executed
   ```typescript
   {
     pty_id: number;
     command: string;
   }
   ```

2. **`pty-command-stopped`**: Emitted when Ctrl+C is pressed
   ```typescript
   {
     pty_id: number;
     command: null;
   }
   ```

**Frontend listener** (in `TerminalPanel.tsx` or `App.tsx`):
```typescript
useEffect(() => {
  const unlisten = listen<{ pty_id: number; command: string }>(
    "pty-command-detected",
    (event) => {
      const { pty_id, command } = event.payload;

      // Find which workspace owns this PTY
      const workspaces = useAppStore.getState().workspaces;
      const terminalTabs = useAppStore.getState().terminalTabs;

      for (const ws of workspaces) {
        const tabs = terminalTabs[ws.id] || [];
        // Match pty_id to terminal tab (need to store pty_id on TerminalTab)
        const tab = tabs.find(t => t.pty_id === pty_id);
        if (tab) {
          useAppStore.getState().setWorkspaceTerminalCommand(ws.id, command);
          break;
        }
      }
    }
  );

  return () => { unlisten.then(fn => fn()); };
}, []);
```

### 3.7 PTY ID Storage on Terminal Tabs

**Problem**: Frontend needs to map `pty_id` back to `workspace_id` when receiving events.

**Solution**: Store `pty_id` in the frontend `TerminalTab` type.

**File**: `src/ui/src/types/terminal.ts`

```typescript
export interface TerminalTab {
  id: number;
  workspace_id: string;
  title: string;
  is_script_output: boolean;
  sort_order: number;
  created_at: string;
  pty_id?: number; // NEW: Added when PTY is spawned
}
```

**Update flow**: When `spawnPty()` succeeds, immediately update the terminal tab with the PTY ID:

```typescript
const ptyId = await spawnPty(worktreePath);
updateTerminalTab(tabId, { pty_id: ptyId });
```

## 4. Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/state.rs` | Add `input_buffer`, `last_command` to `PtyHandle` |
| `src-tauri/src/pty.rs` | Detect newlines in `write_pty`, extract commands, emit events; add `get_pty_info` command |
| `src-tauri/src/main.rs` | Register `get_pty_info` command |
| `src/ui/src/types/terminal.ts` | Add `pty_id?: number` to `TerminalTab` |
| `src/ui/src/stores/useAppStore.ts` | Add `workspaceTerminalCommands`, `setWorkspaceTerminalCommand` |
| `src/ui/src/components/terminal/TerminalPanel.tsx` | Store `pty_id` on tab after spawn, add event listener for `pty-command-detected` |
| `src/ui/src/components/sidebar/Sidebar.tsx` | Display terminal command below branch name |
| `src/ui/src/components/sidebar/Sidebar.module.css` | Add styles for `.terminalCommand` |

## 5. Edge Cases & Limitations

### 5.1 Known Limitations

1. **Natural process exit not detected**: Command stays visible if process exits naturally (not via Ctrl+C)
   - **Example**: `node script.js` that finishes → command remains visible
   - **Mitigation**: Ctrl+C (most common way to stop processes) clears the command
   - **Future**: Could monitor child process exit via `child.try_wait()`

2. **Multiple terminals**: Only shows one command per workspace (the most recent)
   - **Mitigation**: Users typically run one main process per workspace
   - **Future**: Could show count (e.g., "2 processes")

3. **Builtins shown briefly**: User might see `cd src` flash before being ignored
   - **Mitigation**: Update is fast, minimal UX impact

4. **Multiline commands**: Only last line is captured
   - **Mitigation**: Most commands are single-line; multiline is edge case

### 5.2 Builtin Command Handling

Ignore these commands (don't update sidebar):
- `cd`, `ls`, `pwd`, `echo`, `export`, `alias`, `history`, `clear`, `exit`, `source`, `.`, `eval`, `set`, `unset`

Rationale: These are navigation/environment commands, not persistent processes.

### 5.3 Command Truncation

- Max display length: 40 characters
- Truncate with ellipsis: `npm run dev --port 3000 --ho...`
- Full command available on hover (via `title` attribute)

## 6. Testing

### 6.1 Unit Tests

**`src-tauri/src/pty.rs`**:
- `test_extract_command_from_buffer`: Valid command → extracted correctly
- `test_ignore_builtin_commands`: `cd`, `ls` → ignored
- `test_preserve_full_command`: `rails server -p 3000` → full command stored
- `test_empty_input`: `\n` alone → ignored
- `test_multiline_handling`: Multiple commands → last one wins
- `test_ctrl_c_clears_command`: `\x03` → clears last_command, emits stopped event

### 6.2 Integration Tests

1. **Command capture**:
   - Type `npm run dev\n` → Event emitted with `command: "npm run dev"`
   - Verify sidebar shows `▸ npm run dev`

2. **Builtin filtering**:
   - Type `cd src\n` → No event emitted
   - Sidebar unchanged

3. **Multiple terminals**:
   - Workspace with 2 terminals
   - First runs `npm run dev`, second runs `rails server`
   - Sidebar shows most recent command

4. **Workspace switching**:
   - Switch between workspaces → Each shows its own command

### 6.3 Manual Verification

- [ ] Start dev server (`npm run dev`) → Command appears in sidebar
- [ ] Press Ctrl+C → Command disappears from sidebar
- [ ] Restart server → Command reappears
- [ ] Navigate with `cd` → Sidebar unchanged
- [ ] Long command → Truncated with ellipsis
- [ ] Hover truncated command → Full command in tooltip
- [ ] Run short script that finishes → Command persists (known limitation)
- [ ] Close terminal → Command persists (known limitation)
- [ ] Archive workspace → Command cleared
- [ ] Remote workspace → Works identically (if remote PTY tracking added)

## 7. Future Enhancements

### 7.1 Process Exit Detection

Add a background thread to poll `child.try_wait()` and emit `pty-process-exited` events. Clear command when process exits.

### 7.2 Multiple Process Display

Show count: `▸ 2 processes` or list multiple commands (collapsible).

### 7.3 Process Management Actions

Right-click command in sidebar → "Stop process" → Sends Ctrl+C to PTY.

### 7.4 Persistence Across Restarts

Store last command in database (`terminal_tabs` table) so it survives app restarts.

## 8. Example Scenarios

### Scenario 1: Frontend Developer

```
Workspaces:
  ✓ ssk-web
    claudette/fix-auth-bug
    ▸ npm run dev

  ✓ ssk-api
    claudette/add-endpoint
    ▸ rails server -p 3001

  ○ claudette
    claudette/feature-xyz
    (no terminal command)
```

**UX**: User can immediately see which workspaces have servers running without switching tabs.

### Scenario 2: Background Jobs

```
Workspaces:
  ✓ data-pipeline
    claudette/optimize-etl
    ▸ python process_queue.py
```

**UX**: User knows the background job is running while working in a different workspace.

### Scenario 3: Docker Compose

```
Workspaces:
  ✓ microservices
    claudette/fix-auth
    ▸ docker compose up
```

**UX**: Clear indication that Docker services are running.

## 9. Rollout Plan

1. **Phase 1**: Backend command tracking + event emission
   - Implement `PtyHandle` changes
   - Add `write_pty` logic
   - Add tests

2. **Phase 2**: Frontend state management
   - Add store fields
   - Wire up event listeners
   - Update `TerminalTab` type

3. **Phase 3**: UI integration
   - Update sidebar component
   - Add CSS styling
   - Test across themes

4. **Phase 4**: Polish
   - Add tooltip for full command
   - Refine builtin ignore list
   - Performance testing

## 10. Success Metrics

- Users can identify active dev servers without switching workspaces
- Command updates appear within 100ms of user pressing Enter
- No performance degradation with 10+ workspaces
- Builtin commands are reliably filtered out
