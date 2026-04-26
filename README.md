<p align="center">
  <img src="assets/logo.png" alt="Claudette" width="128" />
</p>

<h1 align="center">Claudette</h1>

<p align="center">Claude's missing better half — a companion tool for Claude Code usage.</p>

<p align="center">
  <a href="https://codecov.io/gh/utensils/claudette"><img src="https://codecov.io/gh/utensils/claudette/graph/badge.svg" alt="codecov"/></a>
  <a href="https://discord.gg/Ks9Ghnem"><img src="https://img.shields.io/discord/1491165880820699398?logo=discord&label=Discord" alt="Discord"/></a>
  <a href="https://www.reddit.com/r/ClaudetteApp"><img src="https://img.shields.io/reddit/subreddit-subscribers/ClaudetteApp?style=social" alt="Reddit"/></a>
</p>

Claudette is a cross-platform desktop application built with [Tauri 2](https://tauri.app) (Rust backend) and React/TypeScript (frontend). It provides a lightweight interface for managing and orchestrating Claude Code sessions, similar in spirit to [Conductor.build](https://conductor.build) but with a focused feature set. Unlike most similar tools, Claudette runs natively on **macOS** (Apple Silicon + Intel), **Linux** (x86_64 + aarch64, Wayland + X11), and **Windows** (x86_64 + ARM64).

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain, edition 2024)
- [Bun](https://bun.sh/) (JavaScript runtime and package manager)
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli --version "^2"`
- Platform dependencies for Tauri:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: System libraries for WebKitGTK and ALSA (the latter is needed by the voice-input recorder). On Debian/Ubuntu:

    ```sh
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      libasound2-dev
    ```

    Equivalents on other distros: `alsa-lib-devel` (Fedora/RHEL), `alsa-lib` (Arch). Nix users get this automatically via `flake.nix`.

## Getting started

```sh
# Install frontend dependencies
cd src/ui && bun install && cd ../..

# Run in development mode (hot-reload)
cargo tauri dev

# Build optimized release binary
cargo tauri build

# Run backend tests
cargo test --all-features

# Lint
cargo clippy --workspace --all-targets

# Check frontend types
cd src/ui && bunx tsc --noEmit
```

### macOS: voice input in dev mode

`cargo tauri dev` runs the binary directly, which is fine for everything **except** the Apple Speech voice-input provider. macOS's privacy system (TCC) refuses to grant Microphone or Speech Recognition permissions to a bare Mach-O binary, and aborts the process when the prompt appears.

Use the dev script instead — it wraps the binary in a signed `Claudette Dev.app` bundle (with the right `Info.plist` usage strings + entitlements) and launches it via Launch Services:

```sh
./scripts/dev.sh
```

If you don't need voice input, plain `cargo tauri dev` is still fine.

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

## Shell integration (optional)

Claudette can track terminal commands and display them in the sidebar with status indicators (running, success, failure). This requires adding a snippet to your shell's RC file.

### Zsh

Add to `~/.zshrc`:

```bash
# Claudette shell integration
if [[ -n "$CLAUDETTE_PTY" ]]; then
    _claudette_precmd() {
        local exit_code=$?
        printf '\033]133;D;%s\007' "$exit_code"
        printf '\033]133;A\007'
        return $exit_code
    }

    _claudette_preexec() {
        printf '\033]133;B\007'
        local cmd_encoded=$(printf '%s' "$1" | jq -sRr @uri 2>/dev/null || printf '%s' "$1" | od -An -tx1 | tr ' ' '%' | tr -d '\n')
        if [[ -n "$cmd_encoded" ]]; then
            printf '\033]133;E;%s\007' "$cmd_encoded"
        fi
        printf '\033]133;C\007'
    }

    autoload -Uz add-zsh-hook
    add-zsh-hook precmd _claudette_precmd
    add-zsh-hook preexec _claudette_preexec
fi
```

### Bash

Add to `~/.bashrc`:

```bash
# Claudette shell integration
if [[ -n "$CLAUDETTE_PTY" ]]; then
    _claudette_prompt_start() {
        printf '\033]133;A\007'
    }

    _claudette_prompt_cmd() {
        local exit_code=$?
        printf '\033]133;D;%s\007' "$exit_code"
        _claudette_prompt_start
        return $exit_code
    }

    _claudette_preexec() {
        printf '\033]133;B\007'
        local cmd_encoded=$(printf '%s' "$BASH_COMMAND" | jq -sRr @uri 2>/dev/null || echo "")
        if [[ -n "$cmd_encoded" ]]; then
            printf '\033]133;E;%s\007' "$cmd_encoded"
        fi
        printf '\033]133;C\007'
    }

    PROMPT_COMMAND="_claudette_prompt_cmd"
    trap '_claudette_preexec' DEBUG
fi
```

### Fish

Add to `~/.config/fish/config.fish`:

```fish
# Claudette shell integration
if test -n "$CLAUDETTE_PTY"
    function __claudette_prompt_start --on-event fish_prompt
        printf '\033]133;A\007'
    end

    function __claudette_preexec --on-event fish_preexec
        printf '\033]133;B\007'
        set cmd (string join ' ' $argv)
        set cmd_encoded (string escape --style=url -- $cmd)
        if test -n "$cmd_encoded"
            printf '\033]133;E;%s\007' "$cmd_encoded"
        end
        printf '\033]133;C\007'
    end

    function __claudette_postexec --on-event fish_postexec
        printf '\033]133;D;%s\007' $status
    end
end
```

After adding the snippet, restart your terminal or run `source ~/.zshrc` (or `~/.bashrc`/`~/.config/fish/config.fish`). Commands will now appear in the sidebar.

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

Join us on [Discord](https://discord.gg/aumGBKccmD) to ask questions, share feedback, and connect with other Claudette users.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) to get started. All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development notes

- The project uses Rust edition 2024 and Bun as the frontend package manager.
- The backend (`src/`) is a library crate consumed by the Tauri binary (`src-tauri/`).
- See `CLAUDE.md` for detailed architecture and contribution guidelines.

## License

This project is licensed under the [MIT License](LICENSE).
