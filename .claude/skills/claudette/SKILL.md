---
name: claudette
description: Drive the running Claudette desktop app from the command line — list and create workspaces, send prompts to chat sessions, fan out batch manifests across many workspaces, list pull requests via SCM plugins, invoke arbitrary plugin operations. Use when the user asks to list/create/archive workspaces, send a message to a Claudette session, kick off a phase plan or multi-workspace fan-out, check PRs from a workspace, or otherwise interact with their open Claudette app from outside the GUI.
when_to_use: |
  Trigger when the user mentions Claudette workspaces, sessions, batch / phase plans, "send this prompt to N workspaces", "list my workspaces", "what's running in Claudette", "create a workspace for X", "show me the PR for this workspace", or asks to invoke a Claudette SCM/env plugin operation. Also use proactively when the user has Claudette open and asks for operations that would obviously route through it (e.g. "fan out these 8 prompts as separate Claudette workspaces").
allowed-tools: Bash(claudette:*)
---

# Claudette CLI

Drive the running Claudette desktop app over a per-user local socket. Every command makes one JSON-RPC call to the GUI, so the GUI's tray rebuilds, notifications, agent spawn flow, and event subscribers fire exactly as if the action came from the UI.

## Prerequisites

- The Claudette desktop app must be **open and running**. Every command discovers it via `${state_dir}/Claudette/app.json`. If it isn't running, commands exit with a clear error — do not try to start the app yourself; ask the user to launch it.
- The `claudette` CLI must be on `PATH`. The cleanest install path: open the desktop app and use **Settings → CLI → Install on PATH** (one click; symlinks on macOS/Linux, copies + per-user PATH update on Windows). On Linux `.deb` installs the CLI is already on `/usr/bin/claudette` automatically. Standalone `claudette-cli-<platform>` release assets are also published per release for headless / CI consumers.

## Quick start

```bash
# Inspect what the GUI exposes
claudette version
claudette capabilities

# Workspace lifecycle
claudette workspace list
claudette workspace create <repo-id> my-feature
claudette workspace archive <ws-id>

# Send a prompt to a chat session (kicks off an agent turn in the GUI)
claudette chat send <session-id> "your prompt"
claudette chat send <session-id> @prompts/feature.md --model sonnet --plan
```

## Top-level commands

| Command | Purpose |
|---|---|
| `version` | Print app + protocol version of the running GUI; warns on CLI/GUI version mismatch |
| `capabilities` | List the JSON-RPC methods the GUI accepts |
| `workspace` (alias `ws`) | List / create / archive workspaces |
| `chat` | List sessions, send messages |
| `repo` | List repositories registered with the GUI |
| `batch` | Run / validate a batch manifest (multi-workspace fan-out) |
| `plugin` | List loaded plugins, invoke any operation directly |
| `pr` | Friendly shortcut over the active SCM provider plugin |
| `rpc` | Raw JSON-RPC escape hatch for methods without a typed wrapper |
| `completion <shell>` | Generate shell completion script |

## Common workflows

### List and inspect workspaces

```bash
claudette workspace list
claudette workspace list --json | jq '.[] | {id, name, branch_name, status}'
```

The first column is the workspace ID — pass it to `archive`, `chat list`, `pr list --workspace …`, etc.

### Create a workspace and send the first prompt

`workspace create` returns the workspace plus a `default_session_id`. The session id is what `chat send` targets:

```bash
claudette workspace create <repo-id> phase-0-builtins --json \
  | jq -r '.default_session_id' \
  | xargs -I {} claudette chat send {} @prompts/43-builtins.md --model sonnet --plan
```

### Send a prompt — three input modes

| Form | Behavior |
|---|---|
| `claudette chat send SID "literal prompt"` | Use the string verbatim |
| `claudette chat send SID @path/to/file.md` | Read the prompt from a file (most common for batch use) |
| `claudette chat send SID -` | Read the prompt from stdin (pipe-friendly) |

Per-turn agent settings (each boolean is tri-state — pass `--flag` to force on, `--no-flag` to force off, omit both to defer to the backend default of `false`):

| Flag | Effect |
|---|---|
| `--model <name>` | Model override (e.g. `opus`, `sonnet`) |
| `--plan` / `--no-plan` | Plan mode on/off |
| `--thinking` / `--no-thinking` | Extended thinking |
| `--fast` / `--no-fast` | Lower-latency variant when supported |
| `--chrome` / `--no-chrome` | Chrome browser mode |
| `--effort <level>` | `low` / `medium` / `high` / `xhigh` / `max` |
| `--disable-1m-context` / `--no-disable-1m-context` | Suppress / re-enable the Max-plan 1M context auto-upgrade |
| `--permission <level>` | `default` / `acceptEdits` / `bypassPermissions` |

### Archive a workspace

```bash
claudette workspace archive <ws-id>
claudette workspace archive <ws-id> --delete-branch       # force on
claudette workspace archive <ws-id> --no-delete-branch    # force off
```

`--delete-branch` is tri-state: omit both halves to defer to the GUI's `git_delete_branch_on_archive` setting; pass either half to override per-call.

### Fan out N workspaces from a YAML manifest

Write a manifest, validate it, run it, watch the sidebar fill in. Workspaces are processed sequentially today (concurrent execution is a follow-up):

```yaml
# phase-0-cleanup.claudette.yaml
repository: <repo-id>
defaults:
  model: sonnet
workspaces:
  - name: builtins-tsx
    prompt_file: ./prompts/43-builtins.md
  - name: shell-rs
    prompt_file: ./prompts/42-shell.md
    model: opus
  - name: app-tsx
    prompt_file: ./prompts/38-app.md
```

```bash
claudette batch validate phase-0-cleanup.claudette.yaml   # lint without executing
claudette batch run      phase-0-cleanup.claudette.yaml
```

`prompt_file` paths resolve relative to the manifest. Validation also enforces workspace-name rules (ASCII alphanumeric + hyphens, no leading/trailing hyphen) so naming bugs surface up front.

### Pull requests for the current workspace

`pr` resolves the active SCM provider per workspace via the GUI's plugin registry. Set `CLAUDETTE_WORKSPACE_ID` in the shell or pass `--workspace`:

```bash
export CLAUDETTE_WORKSPACE_ID=<ws-id>

claudette pr list                  # PRs for this workspace's branch
claudette pr list --all            # every open PR in the repo
claudette pr show 123              # one PR by number
claudette pr list --json | jq .
```

If no SCM plugin matches the repository (plugin disabled, required CLI missing, or unrecognized remote host), the command exits with a helpful error pointing to `claudette plugin list`.

### Generic plugin invocation

Skip the friendly wrappers and call any plugin operation directly:

```bash
claudette plugin list                                       # see what's loaded
claudette plugin invoke github ci_status --workspace <ws>   # any op, any plugin
claudette plugin invoke env-direnv export --workspace <ws> '{"path":"/abs/worktree"}'
```

Workspace context is required because plugin operations resolve paths relative to a worktree. `--workspace` defaults to `$CLAUDETTE_WORKSPACE_ID`.

### Raw JSON-RPC

For methods that don't have a typed subcommand yet (or for debugging):

```bash
claudette rpc list_workspaces
claudette rpc list_chat_sessions '{"workspace_id":"<ws-id>"}'
```

`claudette capabilities` prints every method the running GUI accepts.

## Implicit context

These environment variables are auto-honored:

| Env var | Effect |
|---|---|
| `CLAUDETTE_WORKSPACE_ID` | Default for `--workspace` flag on `pr` and `plugin invoke` |

Inside a Claudette workspace shell these are already set, so `claudette pr list` "just works."

## Errors and edge cases

- **"Claudette desktop app is not running"** — the GUI must be open. Ask the user to launch it.
- **"unauthorized" / connection refused** — discovery file present but socket dead; the user likely killed the GUI without a clean shutdown. Ask them to relaunch.
- **`PluginError: NeedsReconsent` / `CliNotFound`** — surfaced verbatim from the GUI's `PluginRegistry`. Resolve in the GUI's Plugins settings, then retry.
- **`workspace create` fails with branch-name conflict** — pass a different `name` arg; Claudette derives the branch from it.
- **CLI/GUI version mismatch warning** — `claudette version` reports both. Reinstall the bundled CLI from Settings → CLI to bring them back in sync; the IPC layer is version-aware so commands keep working but new methods may be missing.

## Output conventions

- Commands with a human-readable renderer (`workspace list`, `repo list`, `pr list`, `plugin list`) default to a table-ish format and switch to JSON when `--json` is set.
- Other commands always emit JSON regardless of `--json` because they don't have a table renderer yet (`capabilities`, `rpc`, `chat list`, `pr show`, `workspace create` / `archive`, `batch run` summary).
- Pipe `--json` output through `jq` for scripting.

## When to NOT use this skill

- For Claudette **development** debugging (state inspection, monitor logs, screenshots) — use the `claudette-debug` skill instead. It targets the dev-build TCP debug server, not the IPC socket.
- For starting / stopping the Claudette app — the CLI requires the GUI to already be running.
- When the user clearly wants a GUI action (e.g. "click this button") — describe the GUI flow rather than substituting CLI operations that may not match.
