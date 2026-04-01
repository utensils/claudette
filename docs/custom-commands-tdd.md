# Technical Design: Custom Workspace Commands

**Status**: Draft
**Date**: 2026-04-01

## 1. Overview

Add user-defined custom commands to the WorkspaceActions dropdown. Commands run against the active workspace's worktree path, with output captured and displayed in the chat panel as a system message. Commands are configured in the App Settings modal and stored in the local database.

### Example use cases

- `mise trust && mise install` — trust and install toolchain for a new worktree
- `npm install` — install dependencies
- `make test` — run project tests
- `docker compose up -d` — start local services
- `git fetch --all` — sync with remotes

## 2. UX

### 2.1 Running a command

The WorkspaceActions dropdown (in the chat header) currently shows:
- Open in Terminal
- Copy Path

After this change, it additionally shows user-defined commands below a separator:
```
Actions ▾
──────────────
Open in Terminal
Copy Path
──────────────
mise install          ← custom
Run Tests             ← custom
──────────────
Manage Commands...    ← opens settings
```

Clicking a custom command:
1. Runs the command with cwd = worktree path
2. Shows a system message in the chat: "Running: mise install..."
3. On completion, updates the message with output and exit status
4. Non-zero exit shows the output in a warning-styled message

### 2.2 Managing commands

"Manage Commands..." opens the App Settings modal with a new "Custom Commands" section:

- List of existing commands (name + command string)
- Add button to create a new command
- Edit/delete inline on each row
- Name is the display label in the dropdown
- Command is the shell string passed to `sh -c`

## 3. Data Model

### 3.1 Storage: `app_settings` key-value

Custom commands are stored as a JSON array under the `app_settings` key `custom_commands`:

```json
[
  {"name": "mise install", "command": "mise trust && mise install"},
  {"name": "Run Tests", "command": "make test"},
  {"name": "Docker Up", "command": "docker compose up -d"}
]
```

This reuses the existing `app_settings` table and `get_app_setting`/`set_app_setting` commands — no DB migration needed.

Using a dedicated table was considered but rejected: the data is a small, simple list that doesn't need relational queries, indexing, or foreign keys. JSON in a settings key is sufficient and avoids schema changes.

### 3.2 TypeScript type

```typescript
interface CustomCommand {
  name: string;
  command: string;
}
```

## 4. Implementation

### 4.1 Backend: New Tauri command

Add `execute_custom_command` to `src-tauri/src/commands/workspace.rs`:

```rust
#[tauri::command]
pub async fn execute_custom_command(
    command: String,
    worktree_path: String,
) -> Result<CommandOutput, String>
```

Where:
```rust
#[derive(Serialize)]
pub struct CommandOutput {
    pub output: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
}
```

**Execution details** (reuses the setup script pattern):
- `sh -c "<command>"` with `current_dir(worktree_path)`
- `.stdout(Stdio::piped()).stderr(Stdio::piped())`
- `.process_group(0)` for clean process tree kill on timeout
- Concurrent stdout/stderr reading via spawned tokio tasks (prevents pipe buffer deadlock)
- 5-minute timeout with `tokio::time::timeout`
- On timeout: `libc::kill(-pgid, SIGKILL)` + `child.wait()` to reap
- Combined stdout + stderr in output

**Why `command` is passed directly, not looked up by name**: The frontend already has the command list loaded from settings. Passing the command string avoids a DB round-trip and keeps the backend stateless for this operation. The security model is unchanged — the user already controls what commands exist in their settings, and the app already runs arbitrary shell commands through setup scripts, agents, and terminals.

### 4.2 Frontend: Service function

Add to `src/ui/src/services/tauri.ts`:

```typescript
export interface CommandOutput {
  output: string;
  exit_code: number | null;
  success: boolean;
  timed_out: boolean;
}

export function executeCustomCommand(
  command: string,
  worktreePath: string
): Promise<CommandOutput> {
  return invoke("execute_custom_command", { command, worktreePath });
}
```

### 4.3 Frontend: WorkspaceActions changes

Update `src/ui/src/components/chat/WorkspaceActions.tsx`:

1. Load custom commands on mount from `getAppSetting("custom_commands")`
2. Parse JSON array into `CustomCommand[]`
3. Render as additional `<option>` elements with a separator
4. Add "Manage Commands..." option at the bottom
5. On custom command selection:
   - Add a "Running: {name}..." system message to chat
   - Call `executeCustomCommand(command, worktreePath)`
   - Update the message with output and exit status

The component needs access to `addChatMessage` and `selectedWorkspaceId` from the store, and `openModal` to open the settings modal.

### 4.4 Frontend: App Settings Modal

Update `src/ui/src/components/modals/AppSettingsModal.tsx`:

Add a "Custom Commands" section below the existing worktree base directory field:

- Editable list of commands (name input + command input per row)
- "Add Command" button appends a new empty row
- Delete button (X) per row
- Save persists the full list via `setAppSetting("custom_commands", JSON.stringify(commands))`
- Validation: name and command must be non-empty

## 5. Risk Assessment

Custom commands introduce **no new risk category**. The app already executes arbitrary shell commands through:

| Mechanism | How | User control |
|-----------|-----|-------------|
| Setup scripts | `sh -c` on workspace creation | User/team defines in settings or `.claudette.json` |
| Terminal (PTY) | Interactive shell in worktree | User types commands directly |
| Claude Code agents | `Bash` tool with full access | User sets permission level to "Full access" |
| **Custom commands** | `sh -c` on user action | **User defines in settings, explicitly triggers** |

Custom commands are arguably the most intentional — the user both defines and explicitly triggers them. The same timeout, process group kill, and output capture safeguards from setup scripts apply.

No additional Tauri permissions or capabilities are needed. The existing `shell:allow-open` permission covers process spawning.

## 6. Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/commands/workspace.rs` | Add `execute_custom_command` command and `CommandOutput` struct |
| `src-tauri/src/main.rs` | Register `execute_custom_command` |
| `src/ui/src/services/tauri.ts` | Add `executeCustomCommand` service function and `CommandOutput` type |
| `src/ui/src/components/chat/WorkspaceActions.tsx` | Load custom commands, render in dropdown, execute on selection |
| `src/ui/src/components/modals/AppSettingsModal.tsx` | Custom commands editor section |
| `src/ui/src/components/modals/ModalRouter.tsx` | No change needed (appSettings modal already routed) |

## 7. Testing

### Manual verification
- [ ] Add a custom command in App Settings ("echo hello") → appears in Actions dropdown
- [ ] Run the command → system message shows output in chat
- [ ] Command with non-zero exit → warning-styled output message
- [ ] Long-running command (e.g., `sleep 400`) → times out after 5 minutes, message shows timeout
- [ ] Delete a command in settings → disappears from dropdown
- [ ] Edit a command name/string → updated in dropdown
- [ ] "Manage Commands..." opens App Settings to the custom commands section
- [ ] Commands persist across app restarts
- [ ] Commands work with worktree paths containing spaces
- [ ] No commands configured → dropdown shows only the existing two actions (no separator, no "Manage" link)
