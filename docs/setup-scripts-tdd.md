# Technical Design: Setup Scripts

**Status**: Draft
**Date**: 2026-03-31
**Issue**: [#50](https://github.com/utensils/Claudette/issues/50)

## 1. Overview

Add support for per-repo setup scripts that run automatically when a workspace is created. Scripts can be defined in two places:

1. **`.claudette.json`** — a file checked into the repo root, shared with the team via source control
2. **Settings UI** — a per-user setup script configured in the Repository Settings modal

When both exist, `.claudette.json` takes precedence to ensure team consistency.

## 2. `.claudette.json` Schema

```json
{
  "scripts": {
    "setup": "mise trust && mise install"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scripts` | object | no | Container for script definitions |
| `scripts.setup` | string | no | Shell command(s) to run when creating a workspace |

Unknown keys at any level are silently ignored for forward compatibility.

## 3. Precedence

```
Priority (highest → lowest):
1. .claudette.json scripts.setup  ← repo-level, checked into git
2. Settings UI setup script       ← personal, configured in app
3. No setup script                ← nothing runs
```

## 4. Implementation

### 4.1 New module: `src/config.rs`

Parses `.claudette.json` from a given repo root path.

```rust
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ClaudetteConfig {
    #[serde(default)]
    pub scripts: Option<Scripts>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Scripts {
    #[serde(default)]
    pub setup: Option<String>,
}

/// Load and parse .claudette.json from the given directory.
/// Returns Ok(None) if the file doesn't exist.
/// Returns Err with a user-visible message if the file exists but is malformed.
pub fn load_config(repo_path: &Path) -> Result<Option<ClaudetteConfig>, String>
```

- `#[serde(default)]` ensures missing fields deserialize cleanly (e.g. absent `scripts`/`setup` are treated as `None` rather than errors)
- `#[serde(deny_unknown_fields)]` is NOT used — Serde's default behavior is to ignore unknown keys, so extra keys are silently ignored
- File not found → `Ok(None)` (not an error)
- Invalid JSON → `Err("Failed to parse .claudette.json: <serde error>")`

Register in `src/lib.rs`: `pub mod config;`

### 4.2 Database: Migration 5

Add `setup_script` column to the `repositories` table for the Settings UI script:

```sql
ALTER TABLE repositories ADD COLUMN setup_script TEXT;
PRAGMA user_version = 5;
```

### 4.3 Database: Methods

Update `list_repositories` SELECT to include `setup_script` (preserving existing `ORDER BY`):
```sql
SELECT id, path, name, icon, path_slug, created_at, setup_script
FROM repositories ORDER BY name
```

New method:
```rust
pub fn update_repository_setup_script(
    &self,
    id: &str,
    script: Option<&str>,
) -> Result<(), rusqlite::Error>
```

### 4.4 Model: Repository

Add field to `src/model/repository.rs`:
```rust
pub struct Repository {
    // ... existing fields ...
    pub setup_script: Option<String>,
}
```

Add `Serialize` (already derived) so it passes through Tauri IPC.

### 4.5 Workspace creation: Setup script execution

Update `src-tauri/src/commands/workspace.rs` `create_workspace`:

After the workspace is created and inserted into the DB, resolve and execute the setup script:

```
1. Load .claudette.json from repo.path
2. If scripts.setup exists → use it (source = "repo")
3. Else if repo.setup_script exists → use it (source = "settings")
4. Else → skip (no setup script)
5. Execute: sh -c "<script>" with cwd = worktree_path
6. Capture stdout + stderr
7. Timeout after 5 minutes
8. Return result alongside workspace
```

**Return type**: Extend to include setup result:

```rust
#[derive(Serialize)]
pub struct CreateWorkspaceResult {
    pub workspace: Workspace,
    pub setup_result: Option<SetupResult>,
}

#[derive(Serialize, Clone)]
pub struct SetupResult {
    /// "repo" (.claudette.json) or "settings" (Settings UI)
    pub source: String,
    /// The script that was executed
    pub script: String,
    /// Combined stdout + stderr output
    pub output: String,
    /// Process exit code (None if timed out or failed to spawn)
    pub exit_code: Option<i32>,
    /// Whether the script succeeded (exit code 0)
    pub success: bool,
    /// Whether the script was killed due to timeout
    pub timed_out: bool,
}
```

**Platform support**: macOS and Linux only (the project's target platforms). Uses `sh -c` for execution. Windows is not a target platform for this project.

**Execution details**:
- Spawn via `tokio::process::Command::new("sh").arg("-c").arg(&script).current_dir(&worktree_path)`
- Explicitly pipe output: `.stdout(Stdio::piped()).stderr(Stdio::piped())`
- Use `.spawn()` to get a `Child` handle (NOT `.output()`, which doesn't yield a handle for killing on timeout)
- Apply 5-minute timeout via `tokio::time::timeout(Duration::from_secs(300), child.wait_with_output())`
- **On timeout**: explicitly kill the child process via `child.kill().await` to prevent leaked background processes
- Non-zero exit → return `SetupResult { success: false, ... }` (do NOT rollback workspace)
- Timeout → return `SetupResult { success: false, output: "Setup script timed out after 5 minutes", exit_code: None, timed_out: true }`

### 4.6 New and updated Tauri commands

**`commands/repository.rs`**:

**Extend `update_repository_settings`** to accept `setup_script` alongside name and icon. This keeps a single atomic save for the modal — one round-trip, no partial save risk:

```rust
#[tauri::command]
pub async fn update_repository_settings(
    id: String,
    name: String,
    icon: Option<String>,
    setup_script: Option<String>,  // NEW
    state: State<'_, AppState>,
) -> Result<(), String>
```

```rust
#[tauri::command]
pub async fn get_repo_config(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<RepoConfigInfo, String>
```

This command looks up the repo by ID in the database to get its path, rather than accepting an arbitrary path. This prevents reading `.claudette.json` from untrusted locations.

Where `RepoConfigInfo` contains:
```rust
#[derive(Serialize)]
pub struct RepoConfigInfo {
    pub has_config_file: bool,
    pub setup_script: Option<String>,
    pub parse_error: Option<String>,
}
```

Register both in `src-tauri/src/main.rs`.

### 4.7 Frontend: Types

**`src/ui/src/types/repository.ts`**:
```typescript
export interface Repository {
  // ... existing fields ...
  setup_script: string | null;
}
```

**New type file or inline**:
```typescript
export interface SetupResult {
  source: string;
  script: string;
  output: string;
  exit_code: number | null;
  success: boolean;
  timed_out: boolean;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  setup_result: SetupResult | null;
}

export interface RepoConfigInfo {
  has_config_file: boolean;
  setup_script: string | null;
  parse_error: string | null;
}
```

### 4.8 Frontend: Service layer

**`src/ui/src/services/tauri.ts`**:

```typescript
export function getRepoConfig(
  repoId: string
): Promise<RepoConfigInfo>
```

`updateRepositorySetupScript` is not needed as a separate function — the setup script is saved atomically via the extended `updateRepositorySettings` command.

Update `createWorkspace` return type from `Promise<Workspace>` to `Promise<CreateWorkspaceResult>`.

### 4.9 Frontend: Repository Settings Modal

Add a "Setup Script" section to `RepoSettingsModal.tsx`:

1. **Textarea** for the personal (Settings UI) setup script
2. **`.claudette.json` indicator**: When detected, show:
   - Read-only display of the repo-level script
   - Note: "This repo includes a `.claudette.json` that defines a setup script. Repo-level scripts take precedence over your personal setup script."
3. **Parse error**: If `.claudette.json` is malformed, show the error message
4. **No `.claudette.json`**: Just show the textarea with no indicator

Load `.claudette.json` info on modal open via `getRepoConfig(repo.id)`. Save the setup script via the extended `updateRepositorySettings` command (single Save button, atomic write of name + icon + setup_script).

### 4.10 Frontend: Workspace creation feedback

In `Sidebar.tsx` `handleCreateWorkspace`:
- After `createWorkspace` returns, check `setup_result`
- If present and failed: show an alert or system chat message with the output
- The workspace is still created regardless of script outcome

## 5. Files Modified

| File | Change |
|------|--------|
| `src/lib.rs` | Add `pub mod config;` |
| `src/config.rs` | **New** — `.claudette.json` parser with tests |
| `src/db.rs` | Migration 5, `update_repository_setup_script`, update `list_repositories` |
| `src/model/repository.rs` | Add `setup_script: Option<String>` |
| `src-tauri/src/commands/workspace.rs` | Setup script resolution + execution in `create_workspace` |
| `src-tauri/src/commands/repository.rs` | Extend `update_repository_settings` with `setup_script`, add `get_repo_config` command |
| `src-tauri/src/main.rs` | Register new commands |
| `src/ui/src/types/repository.ts` | Add `setup_script` field |
| `src/ui/src/types/index.ts` | Export new types |
| `src/ui/src/services/tauri.ts` | Add `getRepoConfig`, update `createWorkspace` return type, extend `updateRepositorySettings` |
| `src/ui/src/components/modals/RepoSettingsModal.tsx` | Setup script section + `.claudette.json` indicator |
| `src/ui/src/components/sidebar/Sidebar.tsx` | Handle `CreateWorkspaceResult`, show setup feedback |

## 6. Testing

### Unit tests (`src/config.rs`)
- Valid `.claudette.json` with setup script → parses correctly
- Valid `.claudette.json` without `scripts` key → `Ok(Some(config))` with `scripts: None`
- Valid `.claudette.json` with `scripts` but no `setup` → `scripts.setup` is `None`
- Valid `.claudette.json` with unknown extra keys → ignored, no error
- Malformed JSON (syntax error) → `Err` with user-visible message
- Missing `.claudette.json` → `Ok(None)`

### Integration tests
- Precedence: `.claudette.json` script overrides Settings UI script
- Missing `.claudette.json` falls back to Settings UI script
- Missing both → no script runs
- Script execution: success (exit 0), failure (non-zero exit)
- Script timeout behavior
- Workspace is created regardless of script failure

### Manual verification
- Settings UI continues to work identically when no `.claudette.json` is present
- `.claudette.json` indicator appears in Repo Settings when file exists
- Override relationship is communicated clearly in the UI
- Malformed `.claudette.json` shows diagnostic warning

## 7. Examples

**Node.js project with mise:**
```json
{
  "scripts": {
    "setup": "mise trust && mise install && npm install"
  }
}
```

**Python project with uv:**
```json
{
  "scripts": {
    "setup": "uv sync"
  }
}
```

**Elixir project with asdf:**
```json
{
  "scripts": {
    "setup": "asdf install && mix deps.get && mix compile"
  }
}
```
