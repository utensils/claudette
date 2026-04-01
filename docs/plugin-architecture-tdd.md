# Technical Design: Plugin Architecture

**Status**: Draft
**Date**: 2026-03-31

## 1. Introduction

Claudette currently hardcodes all integrations — git operations, diff parsing, agent management. As we expand into SCM provider features (pull requests, issues, CI checks), hardcoding each provider (GitHub, GitLab, Bitbucket) creates tight coupling and limits extensibility.

This TDD proposes a Lua-based plugin architecture that allows SCM providers and other capabilities to be implemented as self-contained plugins. The first concrete use case: encapsulating GitHub CLI (`gh`) and GitLab CLI (`glab`) so the application can manage source control, PRs, issues, and CI checks through a common interface without provider-specific code in the core.

## 2. Glossary

| Term | Definition |
|------|-----------|
| **Plugin** | A directory containing a TOML manifest and Lua entry point that implements one or more capabilities |
| **Capability** | A category of operations a plugin provides (e.g. `scm`, `ci`, `deploy`) |
| **Operation** | A single function within a capability (e.g. `list_pull_requests`, `ci_status`) |
| **Host API** | The set of Rust functions exposed to Lua plugins via the `host` table |
| **Manifest** | A `plugin.toml` file declaring metadata, required CLIs, capabilities, and config schema |
| **Luau** | Roblox's typed Lua variant — provides type annotations and stricter semantics over standard Lua 5.4 |

## 3. Current State

All capabilities are implemented directly in Rust modules:

- `src/git.rs` — git worktree operations via `tokio::process::Command` shelling out to `git`
- `src/agent.rs` — Claude CLI subprocess management with JSON streaming
- `src/diff.rs` — diff parsing and git diff operations
- `src/db.rs` — SQLite persistence

There is no plugin system, hook mechanism, or extension point. Adding a new integration (e.g. GitHub PRs) would require:
1. New Rust module in `src/`
2. New Tauri commands in `src-tauri/src/commands/`
3. New TypeScript services and components
4. Rebuilding and releasing the entire application

This approach does not scale across providers and prevents users from adding custom integrations.

## 4. Not in Scope

- **Plugin marketplace or registry** — plugins are loaded from the local filesystem only; no remote discovery or installation mechanism
- **Plugin sandboxing via WASM** — evaluated and deferred; Lua's controlled environment is sufficient for the subprocess-wrapping use case (see Section 5.1 for rationale)
- **UI-rendering plugins** — plugins cannot contribute custom React components; they expose data through structured types that the core UI renders
- **Plugin-to-plugin communication** — no inter-plugin API; each plugin operates independently
- **Windows support** — the project targets macOS and Linux only; `host.exec` uses Unix subprocess semantics

## 5. Technical Design

### 5.1 Runtime Decision: Lua (Luau) via `mlua`

Four runtimes were evaluated:

| Criterion | Lua (mlua) | WASM (wasmtime) | Rhai | deno_core |
|-----------|-----------|-----------------|------|-----------|
| Binary size impact | +1-2 MB | +10-15 MB | +1 MB | +30 MB |
| Cold start impact | ~100μs | ~10-50ms/module | ~100μs | ~100ms |
| Async subprocess support | Via host API | Requires complex host interface | Limited | Native |
| Plugin author UX | Good (Luau types) | Moderate (needs WASM toolchain) | Good | Excellent |
| Ecosystem maturity | Excellent | Good | Moderate | Excellent |

**Decision: Luau via `mlua`** for these reasons:

1. **The SCM use case is subprocess orchestration.** Plugins mostly call CLI tools (`gh`, `glab`) and reshape JSON output. Lua excels at this lightweight glue logic. WASM would need a complex host interface just to spawn processes.
2. **Binary size.** `mlua` with `luau` + `vendored` adds ~1-2 MB, well within the 30 MB target. `wasmtime` would add 10-15 MB.
3. **Cold start.** Lua VM initialization takes microseconds. WASM module compilation takes tens of milliseconds per module.
4. **Async bridging.** `mlua` supports async Rust functions. A plugin calls `host.exec("gh", {...})` and the Rust side runs it via tokio, yielding back to the Lua coroutine on completion. This matches the existing `run_git` pattern in `src/git.rs`.
5. **Luau variant.** Provides type annotations and better error messages over vanilla Lua 5.4 at negligible size cost.

### 5.2 Plugin Directory Structure

Plugins are discovered from a single directory:

```
~/.claudette/plugins/
  github-scm/
    plugin.toml          # manifest (required)
    init.lua             # entry point (required)
    lib/                 # optional helper modules
      pr.lua
      issues.lua
  gitlab-scm/
    plugin.toml
    init.lua
```

On macOS, `~/.claudette/plugins/` resolves via `dirs::home_dir()`. Each plugin is a subdirectory containing at minimum `plugin.toml` and `init.lua`.

### 5.3 Manifest Format

```toml
[plugin]
id = "github-scm"
name = "GitHub SCM Provider"
version = "0.1.0"
description = "GitHub integration via gh CLI"
author = "Claudette Contributors"

[plugin.requires]
cli = ["gh"]                        # CLI tools that must be on PATH

[capabilities]
kind = "scm"                        # capability category
operations = [
  "list_pull_requests",
  "create_pull_request",
  "merge_pull_request",
  "get_pull_request",
  "list_issues",
  "create_issue",
  "update_issue",
  "ci_status",
  "list_branches",
  "commit_and_push",
]

# Declarative config schema — the UI auto-generates a settings form from this
[config.fields.default_base_branch]
type = "string"
label = "Default base branch"
default = "main"

[config.fields.auto_draft]
type = "boolean"
label = "Create PRs as draft by default"
default = true
```

**Rust types** (`src/plugin/manifest.rs`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub plugin: PluginMeta,
    pub capabilities: PluginCapabilities,
    #[serde(default)]
    pub config: PluginConfigSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub requires: PluginRequirements,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginRequirements {
    #[serde(default)]
    pub cli: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCapabilities {
    pub kind: String,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginConfigSchema {
    #[serde(default)]
    pub fields: HashMap<String, ConfigField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    #[serde(rename = "type")]
    pub field_type: String,         // "string", "boolean", "select"
    pub label: String,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub options: Vec<String>,       // for "select" type
}
```

### 5.4 Host API

The host API is the set of Rust async functions registered into the Lua VM as the `host` global table. This is the security boundary — plugins interact with the system exclusively through these functions.

```rust
// src/plugin/host_api.rs

pub fn register_host_api(lua: &Lua, ctx: HostContext) -> mlua::Result<()> {
    let host = lua.create_table()?;

    // Execute a subprocess — restricted to manifest-declared CLIs
    // Returns: { stdout: string, stderr: string, code: number }
    host.set("exec", lua.create_async_function(/* ... */))?;

    // Read workspace metadata
    // Returns: { id, name, branch, worktree_path, repo_path }
    host.set("workspace", lua.create_function(/* ... */))?;

    // Read plugin config value (set by user in settings UI)
    host.set("config", lua.create_function(/* ... */))?;

    // Decode JSON string to Lua table
    host.set("json_decode", lua.create_function(/* ... */))?;

    // Encode Lua table to JSON string
    host.set("json_encode", lua.create_function(/* ... */))?;

    // Structured logging (debug, info, warn, error)
    host.set("log", lua.create_function(/* ... */))?;

    lua.globals().set("host", host)?;
    Ok(())
}
```

**`HostContext`** carries the data needed by host functions:

```rust
pub struct HostContext {
    pub plugin_id: String,
    pub allowed_cli: Vec<String>,       // from manifest requires.cli
    pub workspace_info: WorkspaceInfo,   // id, name, branch, paths
    pub config: HashMap<String, serde_json::Value>,
}
```

#### Security Model

| Constraint | Enforcement |
|-----------|-------------|
| `host.exec` only runs declared CLIs | Checks executable name against `manifest.requires.cli`; rejects anything not listed |
| No raw filesystem access | Lua `os` and `io` standard libraries are removed from the VM |
| Working directory | `host.exec` sets `cwd` to the workspace worktree path |
| Execution timeout | Each `call_operation` has a configurable timeout (default 30s) |
| No network access | Plugins cannot make HTTP requests directly; they use CLI tools which handle their own auth |

### 5.5 Plugin Registry and Lifecycle

```rust
// src/plugin/mod.rs

pub struct PluginRegistry {
    plugins: HashMap<String, LoadedPlugin>,
    plugin_dir: PathBuf,
}

pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub config: HashMap<String, serde_json::Value>,
    pub cli_available: bool,
}
```

**Key design decision: fresh Lua VM per `call_operation`, not persistent.**

Each plugin invocation creates a new Lua VM, loads the script, calls the operation function, and destroys the VM. This is simpler, avoids memory leaks from long-running VMs, and matches the stateless nature of CLI calls. The cost is negligible — Lua VM init + script load is ~100μs.

```rust
impl PluginRegistry {
    /// Scan plugin directory, parse manifests, check CLI availability.
    pub fn discover(plugin_dir: &Path) -> Result<Self, PluginError> { /* ... */ }

    /// Get all plugins providing a specific capability kind.
    pub fn plugins_for_kind(&self, kind: &str) -> Vec<&LoadedPlugin> { /* ... */ }

    /// Execute an operation on a plugin.
    pub async fn call_operation(
        &self,
        plugin_id: &str,
        operation: &str,
        args: serde_json::Value,
        ctx: HostContext,
    ) -> Result<serde_json::Value, PluginError> { /* ... */ }
}
```

**Discovery flow at startup:**
1. Resolve `~/.claudette/plugins/` via `dirs::home_dir()`
2. List subdirectories
3. For each, attempt to parse `plugin.toml`
4. Check each `requires.cli` entry via `which` — set `cli_available` flag
5. Store in registry (skip directories with missing or malformed manifests, log a warning)

### 5.6 SCM Provider Interface

The SCM provider is the first capability kind. These types define the structured data exchanged between the core application and SCM plugins:

```rust
// src/plugin/scm.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,          // "open", "closed", "merged"
    pub url: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub ci_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePrArgs {
    pub title: String,
    pub body: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIssueArgs {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiCheck {
    pub name: String,
    pub status: String,         // "pending", "success", "failure"
    pub url: Option<String>,
}
```

The core application uses these types in Tauri commands. The plugin registry handles the Lua ↔ serde_json ↔ Rust type conversion automatically via `mlua`'s `serialize` feature.

### 5.7 Integration with AppState

```rust
// src-tauri/src/state.rs (additions)

pub struct AppState {
    pub db_path: PathBuf,
    pub worktree_base_dir: RwLock<PathBuf>,
    pub agents: RwLock<HashMap<String, AgentSessionState>>,
    pub ptys: RwLock<HashMap<u64, PtyHandle>>,
    pub next_pty_id: AtomicU64,
    pub plugins: RwLock<PluginRegistry>,    // NEW
}
```

**Config persistence** reuses the existing `app_settings` table:
- Plugin configs: key `plugin:<plugin_id>:config`, value is JSON
- Repo-to-plugin binding: key `repo:<repo_id>:scm_plugin`, value is plugin ID

No database migration required.

### 5.8 Tauri Commands

New command module at `src-tauri/src/commands/plugin.rs`:

| Command | Description |
|---------|-------------|
| `list_plugins()` | Returns all discovered plugins with metadata and CLI availability |
| `get_plugin_config(plugin_id)` | Returns current config values for a plugin |
| `set_plugin_config(plugin_id, key, value)` | Persists a config value to `app_settings` |
| `set_repo_scm_plugin(repo_id, plugin_id)` | Binds a repo to an SCM provider plugin |
| `get_repo_scm_plugin(repo_id)` | Returns the active SCM plugin ID for a repo |
| `scm_list_prs(repo_id)` | List pull requests via the repo's active SCM plugin |
| `scm_create_pr(repo_id, args)` | Create a pull request |
| `scm_merge_pr(repo_id, pr_number)` | Merge a pull request |
| `scm_list_issues(repo_id)` | List issues |
| `scm_create_issue(repo_id, args)` | Create an issue |
| `scm_update_issue(repo_id, issue_number, args)` | Update an issue |
| `scm_ci_status(repo_id, branch)` | Get CI check status |

Each SCM command follows the same pattern:
1. Look up the repo to get `repo_path`
2. Look up the active SCM plugin for the repo via `app_settings`
3. Call the plugin operation through `PluginRegistry::call_operation`
4. Deserialize the Lua return value into the appropriate Rust type

### 5.9 Frontend Integration

**TypeScript types** (`src/ui/src/types/plugin.ts`):

```typescript
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: string;
  operations: string[];
  config_schema: Record<string, ConfigField>;
  cli_available: boolean;
}

export interface ConfigField {
  type: "string" | "boolean" | "select";
  label: string;
  default: unknown;
  options?: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  ci_status: string | null;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
}

export interface CiCheck {
  name: string;
  status: string;
  url: string | null;
}
```

**Zustand store** — add a `plugins` slice:

```typescript
plugins: PluginInfo[];
repoScmPlugin: Record<string, string>;  // repo_id -> plugin_id
setPlugins: (plugins: PluginInfo[]) => void;
setRepoScmPlugin: (repoId: string, pluginId: string) => void;
```

**UI integration points:**

| Location | Feature |
|----------|---------|
| Repository settings modal | Dropdown to select SCM provider plugin |
| Right sidebar | "Pull Requests" and "Issues" tabs alongside "Changed Files" |
| Sidebar workspace items | CI status indicator badge |
| Plugin settings page/modal | Auto-generated config form from manifest schema |

### 5.10 Example Plugin: GitHub SCM

```lua
-- plugins/github-scm/init.lua

local M = {}

local function gh(args: {string}): any
    local result = host.exec("gh", args)
    if result.code ~= 0 then
        error("gh failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local data = gh({
        "pr", "list",
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft",
        "--limit", tostring(args.limit or 30),
    })
    local prs = {}
    for _, item in ipairs(data) do
        table.insert(prs, {
            number = item.number,
            title = item.title,
            state = item.state,
            url = item.url,
            author = item.author.login,
            branch = item.headRefName,
            base = item.baseRefName,
            draft = item.isDraft,
        })
    end
    return prs
end

function M.create_pull_request(args)
    local gh_args = {
        "pr", "create",
        "--title", args.title,
        "--body", args.body,
        "--base", args.base,
        "--head", args.branch,
        "--json", "number,title,state,url",
    }
    if args.draft then
        table.insert(gh_args, "--draft")
    end
    return gh(gh_args)
end

function M.merge_pull_request(args)
    return gh({
        "pr", "merge", tostring(args.number),
        "--merge",
        "--json", "number,title,state,url",
    })
end

function M.list_issues(args)
    return gh({
        "issue", "list",
        "--json", "number,title,state,url,labels",
        "--limit", tostring(args.limit or 30),
    })
end

function M.create_issue(args)
    local gh_args = {
        "issue", "create",
        "--title", args.title,
        "--body", args.body,
        "--json", "number,title,state,url",
    }
    for _, label in ipairs(args.labels or {}) do
        table.insert(gh_args, "--label")
        table.insert(gh_args, label)
    end
    return gh(gh_args)
end

function M.ci_status(args)
    local data = gh({
        "pr", "checks",
        args.branch,
        "--json", "name,state,detailsUrl",
    })
    local checks = {}
    for _, item in ipairs(data) do
        table.insert(checks, {
            name = item.name,
            status = string.lower(item.state),
            url = item.detailsUrl,
        })
    end
    return checks
end

function M.commit_and_push(args)
    host.exec("git", { "add", "-A" })
    host.exec("git", { "commit", "-m", args.message })
    host.exec("git", { "push", "-u", "origin", "HEAD" })
    return { success = true }
end

return M
```

### 5.11 Example Plugin: GitLab SCM

```lua
-- plugins/gitlab-scm/init.lua

local M = {}

local function glab(args: {string}): any
    local result = host.exec("glab", args)
    if result.code ~= 0 then
        error("glab failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local data = glab({
        "mr", "list",
        "--output-format", "json",
    })
    local prs = {}
    for _, item in ipairs(data) do
        table.insert(prs, {
            number = item.iid,
            title = item.title,
            state = item.state,
            url = item.web_url,
            author = item.author.username,
            branch = item.source_branch,
            base = item.target_branch,
            draft = item.draft or false,
        })
    end
    return prs
end

function M.create_pull_request(args)
    local glab_args = {
        "mr", "create",
        "--title", args.title,
        "--description", args.body,
        "--source-branch", args.branch,
        "--target-branch", args.base,
        "--output-format", "json",
    }
    if args.draft then
        table.insert(glab_args, "--draft")
    end
    return glab(glab_args)
end

function M.list_issues(args)
    return glab({
        "issue", "list",
        "--output-format", "json",
    })
end

function M.create_issue(args)
    local glab_args = {
        "issue", "create",
        "--title", args.title,
        "--description", args.body,
        "--output-format", "json",
    }
    for _, label in ipairs(args.labels or {}) do
        table.insert(glab_args, "--label")
        table.insert(glab_args, label)
    end
    return glab(glab_args)
end

function M.ci_status(args)
    local data = glab({
        "ci", "status",
        "--branch", args.branch,
        "--output-format", "json",
    })
    local checks = {}
    for _, job in ipairs(data.jobs or {}) do
        table.insert(checks, {
            name = job.name,
            status = string.lower(job.status),
            url = job.web_url,
        })
    end
    return checks
end

return M
```

## 6. Files Modified

| File | Change |
|------|--------|
| `Cargo.toml` | Add `mlua` and `toml` dependencies |
| `src/lib.rs` | Add `pub mod plugin;` |
| `src/plugin/mod.rs` | **New** — `PluginRegistry`, `LoadedPlugin`, `PluginError` |
| `src/plugin/manifest.rs` | **New** — `PluginManifest` types, TOML parsing |
| `src/plugin/loader.rs` | **New** — directory scanning, CLI availability checks |
| `src/plugin/host_api.rs` | **New** — Lua VM setup, `host` table registration, sandbox |
| `src/plugin/scm.rs` | **New** — SCM data types (`PullRequest`, `Issue`, `CiCheck`, etc.) |
| `src/model/plugin.rs` | **New** — `PluginInfo` (frontend-serializable) |
| `src/model/mod.rs` | Add `pub mod plugin;` |
| `src-tauri/src/state.rs` | Add `plugins: RwLock<PluginRegistry>` to `AppState` |
| `src-tauri/src/commands/plugin.rs` | **New** — all plugin Tauri commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod plugin;` |
| `src-tauri/src/main.rs` | Register plugin commands, initialize registry at startup |
| `src/ui/src/types/plugin.ts` | **New** — TypeScript types |
| `src/ui/src/services/tauri.ts` | Add plugin/SCM invoke wrappers |
| `src/ui/src/stores/useAppStore.ts` | Add plugin state slice |
| `src/ui/src/components/modals/PluginSettingsModal.tsx` | **New** — auto-generated config form |
| `src/ui/src/components/right-sidebar/` | Add PR list and CI status panels |
| `plugins/github-scm/plugin.toml` | **New** — GitHub plugin manifest |
| `plugins/github-scm/init.lua` | **New** — GitHub plugin implementation |
| `plugins/gitlab-scm/plugin.toml` | **New** — GitLab plugin manifest |
| `plugins/gitlab-scm/init.lua` | **New** — GitLab plugin implementation |

## 7. Testing

### Use Cases

| # | Use Case | Expected Outcome |
|---|----------|-----------------|
| 1 | Plugin discovery with valid manifest | Plugin appears in `list_plugins` with correct metadata |
| 2 | Plugin discovery with missing `plugin.toml` | Directory skipped, warning logged, other plugins still load |
| 3 | Plugin discovery with malformed TOML | Directory skipped, warning logged |
| 4 | Plugin with missing required CLI | Plugin loads but `cli_available = false`; operations return error |
| 5 | `host.exec` with allowed CLI | Subprocess runs, stdout/stderr/code returned to Lua |
| 6 | `host.exec` with disallowed CLI | Error returned, subprocess NOT spawned |
| 7 | Plugin operation timeout | Operation returns error after timeout, subprocess killed |
| 8 | `scm_list_prs` via GitHub plugin | Returns structured `Vec<PullRequest>` from `gh pr list` output |
| 9 | `scm_create_pr` via GitHub plugin | Calls `gh pr create` with correct args, returns new PR |
| 10 | `scm_ci_status` via GitHub plugin | Returns structured `Vec<CiCheck>` from `gh pr checks` |
| 11 | Same operations via GitLab plugin | Identical return types, different CLI calls |
| 12 | Switch repo from GitHub to GitLab plugin | Subsequent SCM commands route to GitLab plugin |
| 13 | Plugin config persistence | `set_plugin_config` stores value; survives app restart |
| 14 | Manifest config schema renders in UI | Auto-generated form matches declared fields |

### Testing Notes

- **Unit tests** for plugin infrastructure can use small inline Lua scripts that mock CLI output (no real `gh`/`glab` needed)
- **Integration tests** for specific plugins should use recorded CLI output as fixture files
- **Manual verification** requires `gh` and `glab` CLI tools authenticated against real repos
- The GitLab plugin (use case 11) is the key abstraction validation — if the same types work for both providers without core changes, the interface is correct

## 8. Release Plan

### Phase 1: Plugin Infrastructure
- `src/plugin/` module: registry, manifest parsing, loader, host API, sandbox
- Unit tests with mock Lua plugins
- No UI changes, no Tauri commands yet

### Phase 2: SCM Types + Tauri Integration
- SCM data types in `src/plugin/scm.rs`
- Plugin Tauri commands in `src-tauri/src/commands/plugin.rs`
- `PluginRegistry` added to `AppState`, initialized at startup

### Phase 3: GitHub + GitLab Plugins
- `plugins/github-scm/` and `plugins/gitlab-scm/` directories
- Integration tests with fixture data

### Phase 4: Frontend
- TypeScript types, service wrappers, Zustand store slice
- Plugin settings modal, repo SCM provider selector
- PR list, issues list, CI status panels in right sidebar

Each phase is a separate PR. Phases 1-2 can be merged without user-visible changes. Phase 3 adds the plugins (loadable but not yet surfaced in UI). Phase 4 wires everything to the frontend.

## 9. Open Questions

1. **Should `git` be an allowed CLI for all plugins, or must each plugin declare it?** The `commit_and_push` operation needs `git`, but it's not the plugin's "primary" CLI. Options: always allow `git`, or require explicit declaration. — @doomspork
2. **Plugin hot-reload during development?** Currently plugins are discovered at startup. Should we add a `reload_plugins` command for plugin developers? Low cost to implement but not required for v1. — @doomspork
3. **Should bundled plugins ship inside the binary or as resource files?** Tauri's `resources` config can bundle files alongside the binary. Alternatively, the app could seed `~/.claudette/plugins/` on first run. — @doomspork
4. **Per-workspace vs per-repo plugin config?** Current design binds SCM plugins at the repo level. Should individual workspaces be able to override? — @doomspork
