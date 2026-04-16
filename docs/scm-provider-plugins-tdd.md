# Technical Design: SCM Provider Plugins

**Status**: Draft  
**Date**: 2026-04-14  
**Issue**: [#93](https://github.com/utensils/claudette/issues/93)  
**Supersedes**: [PR #55](https://github.com/utensils/claudette/pull/55) (Lua plugin architecture TDD)

## 1. Introduction

Claudette needs to display PR status (open, draft, merged, closed) and CI check results for workspace branches. This must work across git hosting providers (GitHub, GitLab, Bitbucket, Gitea, etc.) without requiring users to sign into Claudette — a key differentiator.

This TDD defines a Lua-based SCM provider system. Each provider is a user-editable Lua script that shells out to CLI tools (`gh`, `glab`, etc.) through a sandboxed host API. The architecture is focused on SCM providers but structured so a broader plugin system can wrap it later.

### Why Lua (Luau) via `mlua`

The core use case is subprocess orchestration — call a CLI tool, parse JSON output, reshape it. Lua excels at this glue logic. Key factors:

| Criterion | Value |
|-----------|-------|
| Binary size impact | ~1-2 MB (within 30 MB target) |
| Cold start | ~100us per VM |
| Async subprocess | Via host API (`host.exec` backed by tokio) |
| Plugin author UX | Good (Luau type annotations, familiar syntax) |
| Security | Controlled environment — no `os`/`io` stdlib, CLI allowlist |

Alternatives evaluated and rejected:
- **WASM** (wasmtime): +10-15 MB binary, complex host interface for subprocess calls
- **Rhai**: Limited ecosystem, weak async story
- **deno_core**: +30 MB binary, overkill for CLI wrapping
- **Pure Rust trait**: Extensible only by recompiling — doesn't meet "support any provider" goal

## 2. Scope

### In Scope

- Plugin discovery, manifest parsing, CLI availability checking
- Sandboxed Lua execution with host API
- SCM operations: `list_pull_requests`, `get_pull_request`, `create_pull_request`, `merge_pull_request`, `ci_status`
- Auto-detection of provider from git remote URL
- Polling, caching, and concurrency control
- Built-in GitHub and GitLab plugins, seeded to `~/.claudette/plugins/`
- Frontend: sidebar badges, right sidebar SCM tab
- Plugin update/versioning for bundled plugins

### Not in Scope

- Issue management (`list_issues`, `create_issue`, etc.) — deferred to a follow-up
- Branch management, commit/push operations
- Plugin marketplace or remote discovery
- UI-rendering plugins (plugins expose data, core UI renders it)
- Plugin-to-plugin communication
- Windows support (macOS + Linux only)

## 3. Plugin Structure

### 3.1 Directory Layout

```
~/.claudette/plugins/
  github/
    plugin.json          # manifest (required)
    init.lua             # entry point (required)
    .version             # app version that seeded this plugin
  gitlab/
    plugin.json
    init.lua
    .version
```

On macOS, `~/.claudette/plugins/` resolves via `dirs::home_dir()`. Each plugin is a subdirectory containing at minimum `plugin.json` and `init.lua`.

### 3.2 Manifest Format (`plugin.json`)

JSON, consistent with all other Claudette config files (`.claudette.json`, `apps.json`, themes). The Tauri app already depends on `serde_json` — no new crate needed.

```json
{
  "name": "github",
  "display_name": "GitHub",
  "version": "1.0.0",
  "description": "GitHub PR and CI status via gh CLI",
  "required_clis": ["gh"],
  "remote_patterns": ["github.com"],
  "operations": [
    "list_pull_requests",
    "get_pull_request",
    "create_pull_request",
    "merge_pull_request",
    "ci_status"
  ],
  "config_schema": {
    "enterprise_hostname": {
      "type": "string",
      "description": "GitHub Enterprise hostname (optional)",
      "required": false
    }
  }
}
```

**Rust types** (`src/plugin/manifest.rs`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub required_clis: Vec<String>,
    #[serde(default)]
    pub remote_patterns: Vec<String>,
    pub operations: Vec<String>,
    #[serde(default)]
    pub config_schema: HashMap<String, ConfigField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    #[serde(rename = "type")]
    pub field_type: String,          // "string", "boolean", "select"
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub options: Vec<String>,        // for "select" type
}
```

The `remote_patterns` field enables data-driven auto-detection. Third-party plugins for Gitea, Forgejo, etc. declare their own hostname patterns.

### 3.3 Entry Point (`init.lua`)

The entry point must return a table with functions matching the declared operations:

```lua
local M = {}

function M.list_pull_requests(args)
    -- ...
    return prs  -- table of PullRequest-shaped objects
end

function M.ci_status(args)
    -- ...
    return checks  -- table of CiCheck-shaped objects
end

return M
```

## 4. Host API

The host API is the set of Rust async functions registered into the Lua VM as the `host` global table. This is the security boundary.

### 4.1 Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `host.exec` | `(cmd: string, args: {string})` | `{stdout: string, stderr: string, code: number}` |
| `host.json_decode` | `(str: string)` | Lua table |
| `host.json_encode` | `(table: table)` | JSON string |
| `host.workspace` | `()` | `{id, name, branch, worktree_path, repo_path}` |
| `host.config` | `(key: string)` | Config value or nil |
| `host.log` | `(level: string, msg: string)` | nil |

### 4.2 `host.exec` Details

```rust
// Pseudocode for the exec implementation
async fn host_exec(cmd: &str, args: Vec<String>, ctx: &HostContext) -> ExecResult {
    // 1. Validate cmd is in allowed_clis union {"git"}
    // 2. Validate no args contain null bytes
    // 3. Build Command with array args (no shell)
    // 4. Set cwd to workspace worktree path
    // 5. Inherit parent environment (CLIs manage their own auth)
    // 6. Run with 30s timeout
    // 7. Return {stdout, stderr, code}
}
```

Key: arguments are always an **array**, never a string. `Command::new(cmd).args(args)` — no shell is invoked, no metacharacters are interpreted. This eliminates shell injection entirely.

### 4.3 Security Constraints

| Constraint | Enforcement |
|-----------|-------------|
| CLI allowlist | `host.exec` only runs `required_clis` from manifest + `git` (always allowed) |
| No shell invocation | Args passed as array to `Command::new().args()` |
| No filesystem access | Lua `os` and `io` standard libraries removed from VM |
| No network access | No HTTP in Lua; CLI tools handle their own auth |
| Execution timeout | 30s per `host.exec` call |
| Working directory | Always the workspace worktree path, not configurable by plugin |
| Null byte check | Args must not contain `\0` |
| Environment | Inherited from parent process; Claudette does NOT inject tokens |

### 4.4 HostContext

```rust
pub struct HostContext {
    pub plugin_name: String,
    pub allowed_clis: Vec<String>,     // from manifest required_clis + ["git"]
    pub workspace_info: WorkspaceInfo,
    pub config: HashMap<String, serde_json::Value>,
}

pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub repo_path: String,
}
```

## 5. Plugin Registry

### 5.1 Types

```rust
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

### 5.2 Discovery Flow (at startup)

1. Resolve `~/.claudette/plugins/` via `dirs::home_dir()`
2. Seed built-in plugins if needed (see Section 8)
3. List subdirectories
4. For each, attempt to parse `plugin.json`
5. Check each `required_clis` entry via `which` — set `cli_available` flag
6. Store in registry; skip dirs with missing/malformed manifests (log warning)

### 5.3 Operation Execution

```rust
impl PluginRegistry {
    pub async fn call_operation(
        &self,
        plugin_name: &str,
        operation: &str,
        args: serde_json::Value,
        ctx: HostContext,
    ) -> Result<serde_json::Value, ScmError> {
        // 1. Create fresh Lua VM (Luau mode)
        // 2. Remove os/io stdlib
        // 3. Register host API with ctx
        // 4. Load and execute init.lua
        // 5. Get the returned module table
        // 6. Call module[operation](args)
        // 7. Convert Lua return value to serde_json::Value
        // 8. Destroy VM
    }
}
```

**Fresh VM per call, not pooled.** VM creation takes ~100us; CLI calls take 1-3 seconds. The VM cost is noise. Pooling adds complexity (state cleanup, error recovery) without meaningful benefit.

## 6. Provider Detection

### 6.1 Auto-Detection from Git Remote URL

Each plugin declares `remote_patterns` in its manifest — hostname substrings to match. At runtime:

1. Run `git remote get-url origin` for the repository
2. Parse hostname from the URL (handles SSH `git@host:...` and HTTPS `https://host/...`)
3. Match against all loaded plugins' `remote_patterns`
4. First match wins; if multiple match, prefer the one with the longest/most-specific pattern

```rust
// src/plugin/detect.rs
pub fn detect_provider(
    remote_url: &str,
    plugins: &HashMap<String, LoadedPlugin>,
) -> Option<String> {
    let hostname = parse_hostname(remote_url)?;
    plugins.iter()
        .filter(|(_, p)| p.cli_available)
        .find(|(_, p)| {
            p.manifest.remote_patterns.iter()
                .any(|pattern| hostname.contains(pattern))
        })
        .map(|(name, _)| name.clone())
}
```

### 6.2 Manual Override

Users can override the auto-detected provider per-repo via settings. Stored in `app_settings` as `repo:<repo_id>:scm_provider`. When set, it takes precedence over auto-detection.

### 6.3 No Provider

If no provider is detected and none is manually set, SCM features are absent for that repo. No error, no nag. The right sidebar SCM tab shows "No SCM provider detected" with a link to settings.

## 7. SCM Data Types

```rust
// src/plugin/scm.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: PrState,
    pub url: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub ci_status: Option<CiOverallStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiOverallStatus {
    Pending,
    Success,
    Failure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiCheck {
    pub name: String,
    pub status: CiCheckStatus,
    pub url: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiCheckStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePrArgs {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
}
// Note: `branch` (the head branch) is NOT in CreatePrArgs — the Tauri command
// injects it from the workspace context before passing to the plugin. The user
// only specifies title, body, base branch, and draft status.
```

Lua plugins return plain tables with string field values. The Rust layer deserializes via `serde_json` — enum variants match the `snake_case` string values.

## 8. Plugin Seeding & Updates

Built-in plugins (GitHub, GitLab) are embedded in the binary via `include_str!` and written to `~/.claudette/plugins/` on first run.

### 8.1 Seeding Logic

```
On app startup, for each built-in plugin:
  1. Check if ~/.claudette/plugins/<name>/.version exists
  2. If missing:
     - Write plugin.json, init.lua, .version (containing app version)
  3. If .version exists and version < running app version:
     - Compute SHA-256 of init.lua on disk
     - Compare against SHA-256 of embedded default
     - If unchanged: overwrite all files, update .version
     - If modified: skip, log warning:
       "[scm] Plugin '<name>' has user modifications — skipping update.
        Delete .version to force update."
  4. If .version >= running app version:
     - Do nothing
```

This preserves user modifications while keeping unmodified plugins up to date.

### 8.2 Bundled Plugins

Two plugins ship with the initial release:
- `github` — wraps `gh` CLI
- `gitlab` — wraps `glab` CLI

## 9. Polling & Caching

### 9.1 Polling Schedule

All active workspaces are polled on a single fixed interval. The polling loop runs concurrently (up to 8 workspaces at a time, gated by a 4-permit semaphore for CLI invocations).

| Context | Interval | Rationale |
|---------|----------|-----------|
| All active workspaces | 30 seconds | Single fixed interval, polled concurrently |
| Archived workspaces | Never | Not visible |

### 9.2 Cache

In-memory on `AppState`, keyed by `(repo_id, branch_name)`:

```rust
pub struct ScmCache {
    entries: RwLock<HashMap<(String, String), ScmCacheEntry>>,
}

pub struct ScmCacheEntry {
    pub pull_request: Option<PullRequest>,  // PR for this branch
    pub ci_checks: Vec<CiCheck>,
    pub last_fetched: Instant,
    pub error: Option<ScmError>,
}
```

Multiple workspaces on the same branch share one cache entry — no duplicate fetches.

### 9.3 Concurrency Control

A `tokio::sync::Semaphore` with 4 permits on `AppState` caps concurrent CLI invocations. This prevents hammering provider APIs when many workspaces are polling simultaneously.

### 9.4 Refresh Triggers (beyond scheduled polling)

- Workspace selection (if cache is stale)
- Agent finishes running
- After `create_pull_request` or `merge_pull_request` operations
- Manual refresh button in the SCM tab
- Window regains focus (if any cache is older than its tier interval)

## 10. Error Handling

Three tiers:

### 10.1 Provider-Level (CLI missing or unauthenticated)

- CLI availability checked at startup via `which`
- `cli_available` flag stored in `LoadedPlugin`
- If CLI missing: repo SCM tab shows "Install `gh` to enable GitHub integration"
- If CLI installed but not authenticated: detected from first CLI error (exit code, stderr patterns), cached, shows "Run `gh auth login`" with retry button
- No sidebar badge for repos without a working provider

### 10.2 Operation-Level (Lua error, unexpected CLI output)

```rust
pub enum ScmError {
    CliNotFound(String),
    CliAuthError(String),
    CliError { cmd: String, stderr: String, code: i32 },
    ScriptError(String),       // Lua runtime error
    Timeout,
    ParseError(String),        // Failed to deserialize Lua return value
    NoProvider,
    OperationNotSupported(String),
}
```

User-friendly messages in UI. Full error details in logs. Lua stack traces are never shown to users.

### 10.3 Transient (network timeout, remote unreachable)

- Exponential backoff: on failure, double poll interval (up to 5 minutes), reset on success
- UI shows "Last updated Xm ago" rather than a red error banner
- Transient errors do not disable the provider — they just reduce poll frequency temporarily

## 11. Tauri Integration

### 11.1 AppState Additions

```rust
// src-tauri/src/state.rs
pub struct AppState {
    // ... existing fields ...
    pub plugins: RwLock<PluginRegistry>,
    pub scm_cache: ScmCache,
    pub scm_semaphore: Arc<Semaphore>,
}
```

### 11.2 Tauri Commands

New module at `src-tauri/src/commands/scm.rs`:

| Command | Description |
|---------|-------------|
| `list_plugins()` | Returns all discovered plugins with metadata and CLI availability |
| `get_scm_provider(repo_id)` | Returns active provider for a repo (auto-detected or manual override) |
| `set_scm_provider(repo_id, plugin_name)` | Manual override for a repo's provider |
| `load_scm_detail(workspace_id)` | Full PR + CI data for a workspace |
| `scm_create_pr(workspace_id, args)` | Create a pull request |
| `scm_merge_pr(workspace_id, pr_number)` | Merge a pull request |
| `scm_refresh(workspace_id)` | Force refresh cache for a workspace |

Each command follows the pattern:
1. Look up workspace → repository → provider
2. Acquire semaphore permit
3. Call `PluginRegistry::call_operation`
4. Update cache
5. Return typed result

### 11.3 Tauri Events

| Event | Payload | Purpose |
|-------|---------|---------|
| `scm-data-updated` | `ScmDetail` (workspace_id, pull_request, ci_checks, provider, error) | Update sidebar badges + SCM tab + PR banner |
| `workspace-auto-archived` | `{workspace_id, workspace_name}` | Notify frontend that a workspace was auto-archived on merge |

### 11.4 Polling Loop

A background task spawned via `tauri::async_runtime::spawn` in the `.setup()` handler (5-second initial delay):

```
loop {
    read all active workspace IDs + archive_on_merge setting from DB

    poll all workspaces concurrently (buffer_unordered, up to 8):
        for each workspace:
            detect provider from git remote URL
            if cache is fresh (< 30s): return cached data
            acquire semaphore permit (max 4 concurrent CLI calls)
            call list_pull_requests + ci_status via tokio::join!
            update cache
            emit scm-data-updated event

    for each result:
        if archive_on_merge && PR merged:
            auto-archive workspace
            emit workspace-auto-archived event

    sleep 30 seconds
}
```

## 12. Frontend Integration

### 12.1 TypeScript Types

```typescript
// src/ui/src/types/plugin.ts

export interface PluginInfo {
  name: string;
  display_name: string;
  version: string;
  description: string;
  operations: string[];
  cli_available: boolean;
  remote_patterns: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  url: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  ci_status: "pending" | "success" | "failure" | null;
}

export interface CiCheck {
  name: string;
  status: "pending" | "success" | "failure" | "cancelled";
  url: string | null;
  started_at: string | null;
}

export interface ScmSummary {
  hasPr: boolean;
  prState: "open" | "draft" | "merged" | "closed" | null;
  ciState: "success" | "failure" | "pending" | null;
  lastUpdated: number;
}

export interface ScmDetail {
  workspaceId: string;
  pullRequest: PullRequest | null;
  ciChecks: CiCheck[];
  loading: boolean;
  error: string | null;
}
```

### 12.2 Zustand Store Additions

```typescript
// Two-layer SCM state
scmSummary: Record<string, ScmSummary>;      // All active workspaces (for sidebar badges)
scmDetail: ScmDetail | null;                   // Selected workspace only (for right sidebar)

// Actions
setScmSummary: (workspaceId: string, summary: ScmSummary) => void;
setScmDetail: (detail: ScmDetail | null) => void;
```

### 12.3 Sidebar Badges

Extend the existing badge pattern in `Sidebar.tsx` using Lucide git icons:

| State | Icon | Color |
|-------|------|-------|
| PR open, CI passing | `GitPullRequest` | Green |
| PR open, CI pending | `GitPullRequest` | Yellow/amber |
| PR open, CI failing | `GitPullRequest` | Red |
| PR draft | `GitPullRequestDraft` | Gray/muted |
| PR merged | `GitMerge` | Purple |
| PR closed (not merged) | `GitPullRequestClosed` | Red/muted |
| No PR for branch | No badge | — |

Additional Lucide icons available for future use: `GitPullRequestCreate` (action button), `GitBranch`, `GitCommit`.

Badges only show when the agent is NOT running (agent status takes priority, consistent with existing behavior).

### 12.4 Right Sidebar SCM Tab

Add `"scm"` to the tab union type (alongside `"changes"` and `"tasks"`). Contents:

- **PR card**: title, state badge, author, base branch, link to open in browser
- **CI checks list**: name, status icon (check/x/spinner), link to details
- **"Create PR" button**: if no PR exists for the workspace's branch
- **"Merge PR" button**: if PR is open and CI is passing
- **Provider indicator**: which CLI is active, authenticated status
- **Last updated timestamp** with manual refresh button

### 12.5 Data Flow

1. Rust polling loop emits `scm-summary-update` events for all active workspaces
2. Frontend listens and updates `scmSummary` store
3. On workspace selection, frontend calls `invoke("load_scm_detail")` for immediate data
4. Rust also emits `scm-detail-update` for the selected workspace on each poll cycle
5. After `create_pull_request` or `merge_pull_request`, frontend calls `scm_refresh`

## 13. Example Plugin: GitHub

```lua
-- ~/.claudette/plugins/github/init.lua

local M = {}

local function gh(args)
    local result = host.exec("gh", args)
    if result.code ~= 0 then
        error("gh failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local data = gh({
        "pr", "list",
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
        "--limit", "30",
    })
    local prs = {}
    for _, item in ipairs(data) do
        local ci = nil
        if item.statusCheckRollup then
            local all_pass = true
            local any_fail = false
            for _, check in ipairs(item.statusCheckRollup) do
                if check.conclusion == "FAILURE" then any_fail = true end
                if check.conclusion ~= "SUCCESS" then all_pass = false end
            end
            if any_fail then ci = "failure"
            elseif all_pass then ci = "success"
            else ci = "pending" end
        end
        table.insert(prs, {
            number = item.number,
            title = item.title,
            state = item.isDraft and "draft" or string.lower(item.state),
            url = item.url,
            author = item.author.login,
            branch = item.headRefName,
            base = item.baseRefName,
            draft = item.isDraft,
            ci_status = ci,
        })
    end
    return prs
end

function M.get_pull_request(args)
    local data = gh({
        "pr", "view", tostring(args.number),
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
    })
    return {
        number = data.number,
        title = data.title,
        state = data.isDraft and "draft" or string.lower(data.state),
        url = data.url,
        author = data.author.login,
        branch = data.headRefName,
        base = data.baseRefName,
        draft = data.isDraft,
    }
end

function M.create_pull_request(args)
    local gh_args = {
        "pr", "create",
        "--title", args.title,
        "--body", args.body,
        "--base", args.base,
        "--json", "number,title,state,url,headRefName,baseRefName",
    }
    if args.draft then
        table.insert(gh_args, "--draft")
    end
    local data = gh(gh_args)
    return {
        number = data.number,
        title = data.title,
        state = args.draft and "draft" or "open",
        url = data.url,
        author = "",
        branch = data.headRefName,
        base = data.baseRefName,
        draft = args.draft,
    }
end

function M.merge_pull_request(args)
    return gh({
        "pr", "merge", tostring(args.number),
        "--merge",
        "--json", "number,title,state,url",
    })
end

function M.ci_status(args)
    local ok, data = pcall(gh, {
        "pr", "checks", args.branch,
        "--json", "name,state,detailsUrl,startedAt",
    })
    if not ok then
        -- No PR exists for this branch, so no checks
        return {}
    end
    local checks = {}
    for _, item in ipairs(data) do
        table.insert(checks, {
            name = item.name,
            status = string.lower(item.state),
            url = item.detailsUrl,
            started_at = item.startedAt,
        })
    end
    return checks
end

return M
```

## 14. Example Plugin: GitLab

```lua
-- ~/.claudette/plugins/gitlab/init.lua

local M = {}

local function glab(args)
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
            state = item.state == "opened" and "open" or item.state,
            url = item.web_url,
            author = item.author.username,
            branch = item.source_branch,
            base = item.target_branch,
            draft = item.draft or false,
        })
    end
    return prs
end

function M.get_pull_request(args)
    local data = glab({
        "mr", "view", tostring(args.number),
        "--output-format", "json",
    })
    return {
        number = data.iid,
        title = data.title,
        state = data.state == "opened" and "open" or data.state,
        url = data.web_url,
        author = data.author.username,
        branch = data.source_branch,
        base = data.target_branch,
        draft = data.draft or false,
    }
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

function M.merge_pull_request(args)
    return glab({
        "mr", "merge", tostring(args.number),
        "--output-format", "json",
    })
end

function M.ci_status(args)
    local ok, data = pcall(glab, {
        "ci", "status",
        "--branch", args.branch,
        "--output-format", "json",
    })
    if not ok then
        return {}
    end
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

## 15. Files Modified

### New Rust Files

| File | Purpose |
|------|---------|
| `src/plugin/mod.rs` | `PluginRegistry`, `LoadedPlugin`, `ScmError` |
| `src/plugin/manifest.rs` | Manifest types, JSON parsing |
| `src/plugin/host_api.rs` | Lua VM setup, `host` table registration, sandbox |
| `src/plugin/scm.rs` | SCM data types (`PullRequest`, `CiCheck`, etc.) |
| `src/plugin/detect.rs` | Remote URL → provider matching |
| `src/plugin/seed.rs` | Embedded plugin seeding + update logic |
| `src-tauri/src/commands/scm.rs` | Tauri commands for SCM operations |

### Modified Rust Files

| File | Change |
|------|--------|
| `Cargo.toml` | Add `mlua` with `luau`, `serialize`, `async` features |
| `src/lib.rs` | Add `pub mod plugin;` |
| `src/git.rs` | Add `get_remote_url()` function |
| `src-tauri/src/state.rs` | Add `plugins`, `scm_cache`, `scm_semaphore` to AppState |
| `src-tauri/src/commands/mod.rs` | Add `pub mod scm;` |
| `src-tauri/src/main.rs` | Register SCM commands, init plugin registry, start polling loop |

### New Frontend Files

| File | Purpose |
|------|---------|
| `src/ui/src/types/plugin.ts` | TypeScript types for plugins and SCM data |
| `src/ui/src/components/right-sidebar/ScmPanel.tsx` | SCM tab content (PR card, CI checks list) |

### Modified Frontend Files

| File | Change |
|------|--------|
| `src/ui/src/services/tauri.ts` | Add SCM invoke wrappers |
| `src/ui/src/stores/useAppStore.ts` | Add `scmSummary`, `scmDetail` slices |
| `src/ui/src/components/right-sidebar/RightSidebar.tsx` | Add SCM tab |
| `src/ui/src/components/sidebar/Sidebar.tsx` | Add CI/PR status badges |

### New Plugin Files (embedded in binary, seeded to disk)

| File | Purpose |
|------|---------|
| `plugins/github/plugin.json` | GitHub plugin manifest |
| `plugins/github/init.lua` | GitHub plugin implementation |
| `plugins/gitlab/plugin.json` | GitLab plugin manifest |
| `plugins/gitlab/init.lua` | GitLab plugin implementation |

## 16. Testing

| # | Test Case | Expected Outcome |
|---|-----------|-----------------|
| 1 | Plugin discovery with valid manifest | Plugin appears in `list_plugins` with correct metadata |
| 2 | Discovery with missing `plugin.json` | Directory skipped, warning logged, other plugins load |
| 3 | Discovery with malformed JSON | Directory skipped, warning logged |
| 4 | Plugin with missing required CLI | `cli_available = false`; operations return `CliNotFound` |
| 5 | `host.exec` with allowed CLI | Subprocess runs, stdout/stderr/code returned |
| 6 | `host.exec` with disallowed CLI | Error returned, subprocess NOT spawned |
| 7 | `host.exec` with null byte in args | Error returned, subprocess NOT spawned |
| 8 | Operation timeout (30s) | Returns `Timeout` error, subprocess killed |
| 9 | Provider auto-detect for GitHub SSH URL | Returns `"github"` plugin |
| 10 | Provider auto-detect for GitLab HTTPS URL | Returns `"gitlab"` plugin |
| 11 | Provider auto-detect for unknown remote | Returns `None` |
| 12 | Manual provider override | Override takes precedence over auto-detect |
| 13 | `list_pull_requests` via GitHub plugin | Returns `Vec<PullRequest>` from `gh pr list` |
| 14 | `create_pull_request` via GitHub plugin | Calls `gh pr create`, returns new PR |
| 15 | `ci_status` via GitHub plugin | Returns `Vec<CiCheck>` from `gh pr checks` |
| 16 | Same operations via GitLab plugin | Identical types, different CLI calls |
| 17 | Cache deduplication | Two workspaces on same branch share one fetch |
| 18 | Semaphore limits concurrency | Max 4 concurrent CLI calls |
| 19 | Plugin seeding on first run | Files written to `~/.claudette/plugins/` |
| 20 | Plugin update with unmodified files | Files overwritten, .version updated |
| 21 | Plugin update with user modifications | Files preserved, warning logged |

### Testing Notes

- Unit tests use inline Lua scripts that mock CLI output (no real `gh`/`glab` needed)
- Integration tests use recorded CLI output as fixture data
- Manual verification requires authenticated `gh` and `glab` CLI tools
- The GitLab plugin validates the abstraction — if both providers work with identical types, the interface is correct

## 17. Release Plan

### Phase 1: Plugin Infrastructure
- `src/plugin/` module: registry, manifest parsing, host API, sandbox, seeding
- Unit tests with mock Lua plugins
- No UI changes, no Tauri commands yet

### Phase 2: SCM Types + Tauri Integration
- SCM data types, detection, caching
- Plugin + SCM Tauri commands
- `PluginRegistry` added to AppState, polling loop
- Embedded GitHub + GitLab plugins

### Phase 3: Frontend
- TypeScript types, service wrappers, Zustand store slices
- Right sidebar SCM tab
- Sidebar badges with Lucide git icons
- Tauri event listeners

Each phase is a separate PR. Phase 1 can be merged without user-visible changes. Phase 2 adds the backend + plugins. Phase 3 wires everything to the frontend.

## 18. Open Questions

1. **Should we ship a Bitbucket plugin?** Bitbucket has no official CLI, but there's an unofficial `bitbucket-cli`. We could ship a plugin for it or leave it as a user exercise. — @doomspork
2. **Plugin hot-reload for development?** A `reload_plugins` Tauri command would let plugin developers iterate without restarting the app. Low cost to implement but not required for v1. — @doomspork
3. **Per-workspace vs per-repo provider config?** Current design is per-repo. Should individual workspaces override? The use case would be a repo that uses both GitHub and GitLab mirrors. — @doomspork
