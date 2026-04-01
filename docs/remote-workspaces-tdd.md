# Technical Design: Remote Workspaces via SSH

**Status**: Draft
**Date**: 2026-03-31

## 1. Overview

Enable connecting to a Claudette backend running on another machine over SSH, allowing users to work on remote workspaces (repos, worktrees, agents, terminals) from their local Claudette instance. The remote machine runs a headless Claudette backend; the local machine provides the UI.

### Mental model

```
Machine B (local)                    Machine A (remote)
┌─────────────────┐    SSH tunnel    ┌──────────────────┐
│ Claudette UI    │◄──────────────►│ claudette-server  │
│ (Tauri + React) │                  │ (headless backend)│
│                 │                  │                   │
│ Local repos     │                  │ Remote repos      │
│ Local workspaces│                  │ Remote workspaces │
└─────────────────┘                  │ Remote agents     │
                                     │ Remote terminals  │
                                     └──────────────────┘
```

The user sees both local and remote repos/workspaces in the same sidebar. Working on a remote workspace feels identical to local — same chat, diff, and terminal experience.

## 2. Architecture

### 2.1 Remote backend: `claudette-server`

A new binary target in the workspace that runs the Claudette backend headlessly over stdin/stdout using a JSON-RPC protocol. No HTTP server, no port management — SSH handles the transport.

```
src-server/
  Cargo.toml          <- new binary crate
  src/
    main.rs           <- reads JSON-RPC from stdin, writes responses to stdout
    handler.rs        <- dispatches commands (reuses claudette crate)
```

The server binary:
- Reads newline-delimited JSON requests from stdin
- Dispatches to the same logic as Tauri commands (via the `claudette` crate)
- Writes JSON responses to stdout
- Sends streaming events (agent, PTY) as unsolicited JSON messages on stdout
- Manages its own `AppState` (DB, agents, PTYs) in-process
- Exits when stdin closes (SSH disconnects)

This avoids running a long-lived daemon or managing ports. The user installs `claudette-server` on the remote machine (a single self-contained headless binary), and SSH invokes it on demand.

### 2.2 Protocol: JSON-RPC over stdin/stdout

Each message is a single JSON line (newline-delimited).

**Request** (client → server):
```json
{"id": 1, "method": "load_initial_data", "params": {}}
{"id": 2, "method": "send_chat_message", "params": {"workspace_id": "...", "content": "hello", "permission_level": "full"}}
{"id": 3, "method": "write_pty", "params": {"pty_id": 1, "data": [104, 105, 10]}}
```

**Response** (server → client, exactly one per request):

Success:
```json
{"id": 1, "result": {"repositories": [...], "workspaces": [...]}}
{"id": 2, "result": null}
```

Error (mutually exclusive with `result`):
```json
{"id": 2, "error": {"code": -1, "message": "Workspace not found"}}
```

A response contains either `result` or `error`, never both. The `error` object has `code` (integer) and `message` (string).

**Event** (server → client, unsolicited):
```json
{"event": "agent-stream", "payload": {"workspace_id": "...", "event": {...}}}
{"event": "pty-output", "payload": {"pty_id": 1, "data": [27, 91, 72]}}
```

Events have no `id` field — they're push notifications. The client distinguishes responses from events by the presence of `id` vs `event`.

### 2.3 Local side: SSH connection manager

A new module in `src-tauri/` that:
1. Spawns `ssh user@host claudette-server` as a subprocess
2. Reads/writes JSON-RPC over the SSH process's stdin/stdout
3. Translates between Tauri commands and JSON-RPC requests
4. Converts incoming events into Tauri events (same `agent-stream` and `pty-output` event names, but with a remote prefix or connection context)

```rust
// src-tauri/src/remote.rs
pub struct RemoteConnection {
    id: String,
    host: String,
    user: String,
    ssh_process: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_request_id: AtomicU64,
    /// Background task reading stdout — routes responses to pending_requests
    /// and events to the Tauri event bus.
    reader_task: tokio::task::JoinHandle<()>,
}
```

### 2.4 Command routing

The frontend doesn't need to know whether a workspace is local or remote. The routing layer intercepts commands and decides:

- **Local workspace** → existing Tauri command handler (no change)
- **Remote workspace** → serialize as JSON-RPC, send over SSH, deserialize response

This is implemented as a dispatcher in `src-tauri/`:

```rust
// For each command that operates on a workspace_id:
// 1. Look up workspace → determine if it's local or remote
// 2. If local → call existing handler directly
// 3. If remote → find the RemoteConnection, send JSON-RPC, return response
```

For commands that don't reference a workspace (like `load_initial_data`), the local data includes merged results from all active remote connections.

## 3. Data Model Changes

### 3.1 Database: Remote connections table (migration 6)

```sql
CREATE TABLE remote_connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,          -- Display name (e.g., "Work Laptop")
    host        TEXT NOT NULL,          -- SSH host (e.g., "machine-a.local")
    user        TEXT NOT NULL,          -- SSH username
    port        INTEGER DEFAULT 22,     -- SSH port
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

PRAGMA user_version = 6;
```

### 3.2 In-memory state

```rust
pub struct AppState {
    // ... existing fields ...
    remote_connections: RwLock<HashMap<String, RemoteConnection>>,
}
```

### 3.3 Frontend: Remote indicator on workspaces

Workspaces loaded from remote connections need to be identifiable:

```typescript
interface Workspace {
  // ... existing fields ...
  remote_connection_id: string | null;  // null = local
}
```

## 4. New Commands

### 4.1 Connection management

| Command | Input | Output |
|---------|-------|--------|
| `list_remote_connections` | - | `Vec<RemoteConnection>` |
| `add_remote_connection` | `name, host, user, port?` | `RemoteConnection` |
| `remove_remote_connection` | `id` | `()` |
| `connect_remote` | `id` | `RemoteData` (repos + workspaces from remote) |
| `disconnect_remote` | `id` | `()` |

### 4.2 `connect_remote` flow

1. Look up saved connection by ID
2. Spawn `ssh user@host -p port claudette-server` (uses the system's default SSH host key verification — the user's `~/.ssh/known_hosts` and SSH config apply as normal; Claudette does not override host key policy)
3. Start background reader task that reads stdout lines, routes responses to pending request channels, and forwards events to the Tauri event bus
4. Send `load_initial_data` request as the first protocol message
5. Receive remote repos and workspaces
6. Tag each with `remote_connection_id`
7. Return merged data to frontend

### 4.3 `disconnect_remote` flow

1. Close SSH stdin (triggers server exit)
2. Wait for SSH process to exit
3. Remove remote workspaces from sidebar
4. Clean up in-memory state

## 5. Server Binary: `claudette-server`

### 5.1 Crate setup

```toml
# src-server/Cargo.toml
[package]
name = "claudette-server"
version = "0.1.0"
edition = "2024"

[[bin]]
name = "claudette-server"
path = "src/main.rs"

[dependencies]
claudette = { path = ".." }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4"] }
dirs = "5"
portable-pty = "0.8"
```

Add to workspace `Cargo.toml`:
```toml
[workspace]
members = ["src-tauri", "src-server"]
```

### 5.2 Main loop

Each request is dispatched into its own tokio task so the read loop stays free for concurrent requests (critical for PTY — `write_pty` must be processable while `spawn_pty` is streaming output). Parse errors produce a JSON error response rather than terminating the server.

```rust
#[tokio::main]
async fn main() {
    let state = Arc::new(AppState::new(db_path, worktree_base_dir));
    let stdin = tokio::io::stdin();
    let writer = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let reader = BufReader::new(stdin);

    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err = json!({"id": null, "error": {"code": -32700, "message": format!("Parse error: {e}")}});
                write_line(&writer, &err).await;
                continue;
            }
        };

        // Spawn each request as a separate task for concurrency.
        let state = Arc::clone(&state);
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            let response = handle_request(&state, &writer, request).await;
            write_line(&writer, &response).await;
        });
    }
}
```

### 5.3 Command handler

The handler reuses the exact same logic as Tauri commands. Since the `claudette` crate is a library, all the business logic (db, git, diff, agent, config) is shared:

```rust
async fn handle_request(state: &AppState, writer: &Writer, req: Request) -> Response {
    match req.method.as_str() {
        "load_initial_data" => { /* same logic as data.rs */ }
        "send_chat_message" => {
            // Same logic, but instead of app.emit(), write events to stdout
        }
        "spawn_pty" => {
            // Same logic, but PTY output events go to stdout
        }
        // ... etc
    }
}
```

### 5.4 Event emission

For streaming commands (agent, PTY), the server writes unsolicited event lines to stdout:

```rust
async fn emit_event(writer: &Writer, event_name: &str, payload: &impl Serialize) {
    let msg = serde_json::json!({
        "event": event_name,
        "payload": payload
    });
    write_line(writer, &msg).await;
}
```

## 6. Frontend Changes

### 6.1 Connection UI

Add a "Remote" section to the sidebar footer or a dedicated panel:
- "Connect to Remote" button → modal with host/user/port fields + saved connections list
- Connected remotes show their repos/workspaces in the sidebar with a subtle remote indicator (icon or label)
- "Disconnect" button per active connection

### 6.2 Status bar

Show active remote connections: "Connected to machine-a" with a disconnect action.

### 6.3 Transparent routing

The frontend doesn't change how it calls commands. The Tauri command layer handles routing. The only frontend change is:
- Displaying the remote indicator on workspaces
- Managing connections (connect/disconnect UI)
- Showing connection status

## 7. Security

- **Authentication**: Relies entirely on SSH — key-based or password auth via the user's SSH config. Claudette does not store passwords.
- **Host key verification**: Uses the system's default SSH host key policy (`~/.ssh/known_hosts`). Claudette does not override or weaken host key checking. If the remote host is not in `known_hosts`, SSH will prompt the user interactively (or reject the connection if `StrictHostKeyChecking=yes`). This is important because `claudette-server` accepts commands that can modify files and execute shell commands.
- **Encryption**: All traffic encrypted by SSH.
- **Authorization**: The remote `claudette-server` runs as the SSH user, inheriting their filesystem permissions.
- **No exposed ports**: The server binary only communicates via stdin/stdout. There is no network listener to secure.

## 8. Installation

The user needs `claudette-server` installed on the remote machine:

```bash
# Option 1: Build from a checked-out repo
cargo install --path src-server

# Option 2: Install directly from the git repo
cargo install --git https://github.com/utensils/Claudette.git --bin claudette-server

# Option 3: Copy a locally built binary
scp target/release/claudette-server user@remote:~/.local/bin/
```

The installed `claudette-server` is a single command-line executable with no GUI dependencies (no Tauri, no WebKit). It is a standard dynamically linked binary produced by Cargo that depends on the `claudette` core crate, SQLite (bundled), and tokio.

## 9. Implementation Phases

### Phase 1: `claudette-server` binary
- JSON-RPC protocol definition
- Server main loop with stdin/stdout I/O
- Command dispatcher reusing `claudette` crate logic
- Event streaming for agent and PTY
- Standalone testing: `echo '{"id":1,"method":"load_initial_data","params":{}}' | claudette-server`

### Phase 2: SSH connection manager in Tauri
- `RemoteConnection` struct and lifecycle
- SSH subprocess spawning
- JSON-RPC request/response multiplexing
- Event forwarding to Tauri event bus
- Connection management commands

### Phase 3: Command routing layer
- Workspace → local/remote dispatch
- Merged `load_initial_data` across local + remote connections
- Remote-aware workspace commands

### Phase 4: Frontend UI
- Remote connections management UI (add/connect/disconnect)
- Remote indicator on workspaces
- Status bar connection display

### Phase 5: Polish
- Reconnection on SSH drop
- Connection health monitoring
- Error handling for network issues
- Timeout handling for unresponsive remotes

## 10. Files Modified / Created

| File | Change |
|------|--------|
| `Cargo.toml` | Add `src-server` to workspace members |
| `src-server/` | **New** — headless server binary crate |
| `src/db.rs` | Migration 6: `remote_connections` table |
| `src-tauri/src/remote.rs` | **New** — SSH connection manager |
| `src-tauri/src/state.rs` | Add `remote_connections` to `AppState` |
| `src-tauri/src/commands/remote.rs` | **New** — connection management commands |
| `src-tauri/src/main.rs` | Register remote commands |
| `src/ui/src/types/` | Remote connection types |
| `src/ui/src/services/tauri.ts` | Remote connection service functions |
| `src/ui/src/components/sidebar/` | Remote connection UI |
| `src/ui/src/components/layout/StatusBar.tsx` | Connection indicator |

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| SSH key auth not configured | Show clear setup instructions; fall back to password prompt |
| High latency on WAN | Terminal input is buffered locally by xterm.js; agent streaming is naturally async |
| Remote `claudette-server` not installed | Clear error: "claudette-server not found on remote. Install with: ..." |
| SSH connection drops mid-session | Detect broken pipe, show reconnect prompt, agent/PTY processes continue on remote |
| Binary compatibility (different OS/arch) | Provide pre-built binaries for common targets; `cargo install` as fallback |
| Conflicting workspace IDs local vs remote | Prefix remote workspace IDs with connection ID, or use a namespace |

## 12. What This Does NOT Cover

- **Multi-user collaboration**: This is single-user remote access, not real-time collaboration between multiple users on the same workspace
- **File sync**: Files stay on the remote machine. The local machine only sees them through the diff viewer and terminal
- **Remote code editing**: Direct file editing happens through Claude Code agents or the terminal, not a built-in editor
- **VPN/firewall traversal**: The user is responsible for SSH connectivity (VPN, port forwarding, etc.)
