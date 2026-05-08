<p align="center">
  <img src="assets/logo.png" alt="Claudette" width="128" />
</p>

<h1 align="center">Claudette</h1>

<p align="center">Claude's missing better half — a companion tool for Claude Code usage.</p>

<p align="center">
  <a href="https://utensils.github.io/claudette/"><img src="https://img.shields.io/badge/docs-utensils.github.io%2Fclaudette-7c3aed" alt="Documentation"/></a>
  <a href="https://codecov.io/gh/utensils/claudette"><img src="https://codecov.io/gh/utensils/claudette/graph/badge.svg" alt="codecov"/></a>
  <a href="https://discord.gg/JQdfT3Z67F"><img src="https://img.shields.io/discord/1491165880820699398?logo=discord&label=Discord" alt="Discord"/></a>
  <a href="https://www.reddit.com/r/ClaudetteApp"><img src="https://img.shields.io/reddit/subreddit-subscribers/ClaudetteApp?style=social" alt="Reddit"/></a>
</p>

## Highlights

- **[Parallel agents in isolated git worktrees](https://utensils.github.io/claudette/features/parallel-agents/)** — run multiple Claude Code agents simultaneously, each on its own branch with no merge conflicts.
- **[Plan mode and AskUserQuestion handling](https://utensils.github.io/claudette/features/plan-mode/)** — let the agent draft a plan or pause for input, then approve, deny with feedback, or answer from the GUI or the CLI.
- **[Checkpoints and workspace forking](https://utensils.github.io/claudette/features/checkpoints-and-forking/)** — roll any session back to an earlier turn, or fork a workspace from a checkpoint to explore alternates without losing the original.
- **[CLI client + Claude Code skill](https://utensils.github.io/claudette/features/cli-client/)** — script every workspace operation from the terminal; install the bundled skill and a "main" agent can drive Claudette to fan out work across N workspaces.
- **[Remote workspaces over encrypted WebSocket](https://utensils.github.io/claudette/features/remote-workspaces/)** — connect to another machine and work with its repos, agents, and terminals as if they were local. Auto-discovers on LAN via mDNS.
- **[SCM providers (GitHub, GitLab, extensible)](https://utensils.github.io/claudette/features/scm-providers/)** — pull request status, CI checks, and one-click merge without leaving the app, powered by sandboxed Lua plugins.
- **[MCP supervision and env-providers](https://utensils.github.io/claudette/features/mcp-servers/)** — per-repo MCP server config with health monitoring, plus a pluggable env stack ([direnv, mise, dotenv, nix-devshell](https://utensils.github.io/claudette/features/scm-providers/#environment-provider-plugins)).
- **[Voice input](https://utensils.github.io/claudette/features/voice-input/)** — push-to-talk dictation with Apple Speech (macOS) or bundled Whisper, all on-device.
- **[Alternative backends](https://utensils.github.io/claudette/features/alternative-backends/)** _(experimental)_ — run agents through Ollama (local), the OpenAI API, or OpenAI Codex (subscription) instead of Claude. An in-process gateway translates wire formats; chat-header toggles adapt to whichever backend is active.

Full documentation lives at **[utensils.github.io/claudette](https://utensils.github.io/claudette/)**.

## About

Claudette is a cross-platform desktop application built with [Tauri 2](https://tauri.app) (Rust backend) and React/TypeScript (frontend). It provides a lightweight interface for managing and orchestrating Claude Code sessions, similar in spirit to [Conductor.build](https://conductor.build) but with a focused feature set. Unlike most similar tools, Claudette runs natively on **macOS** (Apple Silicon + Intel), **Linux** (x86_64 + aarch64, Wayland + X11), and **Windows** (x86_64 + ARM64).

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain, edition 2024)
- [Bun](https://bun.sh/) (JavaScript runtime and package manager)
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli --version "^2"`
- Platform dependencies for Tauri:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: System libraries for WebKitGTK and (when building with the default `voice` feature) ALSA. On Debian/Ubuntu:

    ```sh
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      libasound2-dev
    ```

    Equivalents on other distros: `alsa-lib-devel` (Fedora/RHEL), `alsa-lib` (Arch). Nix users get this automatically via `flake.nix`.

    Headless or sandboxed Linux environments that lack ALSA can build without voice support:

    ```sh
    cargo tauri build --no-default-features --features tauri/custom-protocol,server
    ```

## Getting started

```sh
# Install frontend dependencies
cd src/ui && bun install && cd ../..
```

### Run in development mode

Two equivalent paths — pick whichever fits the change you're making:

```sh
# Quick path (works for everything except macOS voice input)
cargo tauri dev

# Full-feature path (recommended; required for macOS voice input)
./scripts/dev.sh
```

`./scripts/dev.sh` does a few things `cargo tauri dev` doesn't:

- **macOS only**: wraps the binary in a signed `Claudette Dev.app` bundle (with the right `Info.plist` usage strings and `Entitlements.plist`) and launches it via Launch Services. This is required because macOS's privacy system (TCC) refuses to grant Microphone or Speech Recognition permissions to a bare Mach-O binary and aborts the process when the prompt appears.
- Probes free Vite + debug-eval ports and exports them so multiple dev instances can run side by side.
- Stages the `claudette-cli` sidecar binary so the in-app CLI install path works in dev.
- Writes a per-PID discovery file at `${TMPDIR:-/tmp}/claudette-dev/<pid>.json` consumed by the `/claudette-debug` skill.

### Build, test, lint

```sh
# Build optimized release binary
cargo tauri build

# Run backend tests
cargo test --all-features

# Lint
cargo clippy --workspace --all-targets

# Check frontend types
cd src/ui && bunx tsc --noEmit
```

## Project structure

```
Cargo.toml              # Workspace root + claudette lib crate
src/
  lib.rs                # Backend library entry point
  db.rs                 # SQLite database (rusqlite)
  git.rs                # Async git operations
  diff.rs               # Diff parsing
  agent.rs              # Claude CLI subprocess + streaming
  model/                # Data types
  names/                # Random workspace name generator
  ui/                   # React/Vite frontend
    src/
      components/       # UI components (sidebar, chat, diff, terminal, modals)
      hooks/            # Tauri event listeners
      stores/           # Zustand state management
      services/         # Typed Tauri IPC wrappers
      types/            # TypeScript types matching Rust models
src-tauri/
  Cargo.toml            # Tauri binary crate
  tauri.conf.json       # Tauri configuration
  src/
    main.rs             # Tauri entry point
    commands/           # #[tauri::command] handlers
    state.rs            # Managed application state
    pty.rs              # Terminal PTY management
    transport/          # Remote transport trait + WebSocket client
    remote.rs           # Remote connection manager
    mdns.rs             # mDNS service browser
src-server/
  Cargo.toml            # Server library + standalone binary crate
  src/
    lib.rs              # Server library (shared by Tauri binary and standalone CLI)
    main.rs             # Standalone CLI entry point (clap)
    ws.rs               # WebSocket accept loop + per-connection handler
    handler.rs          # JSON-RPC command dispatcher
    tls.rs              # Self-signed TLS certificate management
    auth.rs             # Pairing token + session token auth
    mdns.rs             # mDNS service advertisement
```

## Command-line client

The `claudette` CLI drives the running desktop app over a local IPC socket. Use it to script workspace creation, send prompts to chat sessions, or fan out a phase-of-work plan across many workspaces at once.

```bash
# Discover what's available
claudette capabilities

# List repos and workspaces
claudette repo list
claudette workspace list

# Create a workspace and dispatch a prompt
claudette workspace create <repo-id> my-task
claudette chat send <session-id> @./prompts/task.md

# Inspect and orchestrate active chat sessions
claudette chat list <workspace-id>
claudette chat show <session-id> --limit 50
claudette chat turns <session-id>
claudette chat send <other-session-id> "Can you review this approach?"
claudette chat stop <session-id>

# Fan out N workspaces from a YAML manifest
claudette batch validate plan.yaml
claudette batch run plan.yaml

# Pull-request shortcuts (resolves the active SCM provider per workspace)
claudette pr list --workspace <workspace-id>
claudette pr show <number> --workspace <workspace-id>

# Generic plugin invocation (escape hatch when no first-class subcommand exists)
claudette plugin list
claudette plugin invoke github list_pull_requests --workspace <workspace-id> '{}'

# Install shell completion
claudette completion zsh > ~/.zsh/completions/_claudette
```

A batch manifest declares one repository, optional defaults, and a list of workspaces with prompts:

```yaml
repository: my-repo
defaults:
  model: sonnet
workspaces:
  - name: builtins-tsx
    prompt_file: ./prompts/43-builtins.md
  - name: shell-rs
    prompt: |
      Implement issue #42 ...
    model: opus
```

The CLI requires the desktop app to be running — every operation flows through the GUI's own command core, so tray icons, notifications, and the workspace list update live as the CLI works. Run `claudette --help` for the full subcommand list. The full reference (with every flag) lives at [docs/features/cli-client](https://utensils.github.io/claudette/features/cli-client/).

Main-agent orchestration uses the same IPC surface: `claudette chat show` returns session metadata, recent transcript messages, completed tool activity, attachment metadata, and pending AskUserQuestion / ExitPlanMode controls. Use `claudette chat answer <session-id> <tool-use-id> --answers-json '{"Question?":"Answer"}'`, `claudette chat approve-plan`, or `claudette chat deny-plan` to resolve pending controls from a terminal or another agent.

### Drive from a Claude Code agent

The repo ships a Claude Code skill at [`.claude/skills/claudette/SKILL.md`](.claude/skills/claudette/SKILL.md) that pre-grants an agent permission to invoke `claudette` and provides a curated playbook of common workflows. Use it from a Claudette checkout (auto-loaded as a project skill), or symlink it into `~/.claude/skills/claudette/` to use it from any project. See [docs/features/cli-client](https://utensils.github.io/claudette/features/cli-client/#driving-claudette-from-a-claude-code-agent) for setup details.

## Remote access

Claudette can connect to workspaces on another machine over an encrypted WebSocket connection. The local app discovers or connects to a remote server and displays remote repos, agents, and terminals alongside local ones.

### Sharing from the desktop app

Click **Share this machine** in the sidebar. The server starts automatically as a subprocess and displays a connection string to share. No separate installation required — the server is embedded in the Claudette binary (gated behind the default-enabled `server` feature).

On startup the server prints a connection string:

```
claudette-server v0.8.0 listening on wss://0.0.0.0:7683
Name: Work Laptop

Connection string (paste into Claudette):
  claudette://work-laptop.local:7683/aBcDeFgH1234...
```

### Headless server (standalone)

For headless machines without a GUI, the standalone server binary is still available:

```sh
# Build and install the standalone server binary
cargo install --path src-server

# Start it (generates a TLS certificate and pairing token on first run)
claudette-server
```

### Connecting from the local app

**Automatic (LAN):** If both machines are on the same network, the server appears automatically in the sidebar under **Nearby**. Click **Connect** and enter the pairing token when prompted.

**Manual:** Click **+ Add remote** in the sidebar footer and paste the full connection string. Claudette authenticates, stores a session token, and reconnects automatically on future launches.

### Server management

```sh
# Regenerate the pairing token (revokes all existing sessions)
claudette-server regenerate-token

# Print the current connection string
claudette-server show-connection-string

# Bind to a specific interface or port
claudette-server --bind 192.168.1.50 --port 9000

# Disable mDNS advertisement
claudette-server --no-mdns
```

All traffic is encrypted with TLS. The local app pins the server's certificate fingerprint on first connection (trust-on-first-use), similar to SSH's `known_hosts`.

## Community

Join us on [Discord](https://discord.gg/JQdfT3Z67F) to ask questions, share feedback, and connect with other Claudette users.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) to get started. All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

### Translations

Claudette currently ships in English and Spanish, and we'd love help adding more languages. Translations live as JSON files under `src/ui/src/locales/<lang>/` (frontend) and `src/locales/<lang>/` (tray menu, notifications, and quit dialog) — most of the work is editing key/value pairs and requires no Rust or TypeScript experience. See [Translating Claudette](CONTRIBUTING.md#translating-claudette) in the Contributing Guide for the step-by-step recipe.

## Development notes

- The project uses Rust edition 2024 and Bun as the frontend package manager.
- The backend (`src/`) is a library crate consumed by the Tauri binary (`src-tauri/`).
- See `CLAUDE.md` for detailed architecture and contribution guidelines.

## Relationship to Anthropic

Claudette is an independent, community-built tool. **It is not affiliated with, endorsed by, or sponsored by Anthropic, PBC.** "Claude" and "Claude Code" are trademarks of Anthropic, PBC; their use here is descriptive — Claudette orchestrates the official Claude Code CLI — and does not imply any partnership.

### How Claudette uses your Claude account

Claudette does **not** authenticate to Anthropic on your behalf. It spawns the official `claude` CLI you have installed locally as a subprocess; the CLI authenticates itself using the credentials you have configured for it. Claudette never reads, copies, or forwards your Claude OAuth tokens, and explicitly strips any inherited subscription tokens from spawned subprocesses so they are never passed through.

### Pro/Max plan usage and parallel agents

Per the [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance):

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

Claudette can run multiple agents in parallel git worktrees. **We recommend keeping default parallelism low (1–3 simultaneous agents)** and treating heavier use as something you explicitly opt into. Whether running N parallel agents counts as "ordinary, individual usage" under your plan is a judgment Anthropic reserves for itself; Claudette is the affordance, but the responsibility for staying within your plan's terms is yours.

If you need higher throughput, the supported path is API-key authentication via [Claude Console](https://platform.claude.com/), which is governed by Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).

### Plugin secrets storage

Claude Code plugins may require their own secrets (API keys, tokens). Claudette stores these in the same secure-storage object Claude Code itself uses — the macOS Keychain entry `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux — but only under its own `pluginSecrets` namespace. Your Claude OAuth tokens (`claudeAiOauth.*`) are never read or written by Claudette's plugin code.

## License

This project is licensed under the [MIT License](LICENSE).
