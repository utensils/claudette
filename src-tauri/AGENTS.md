# Tauri binary crate (`src-tauri/`)

`claudette-tauri` builds the app binary, `claudette-app`. It holds thin `#[tauri::command]` wrappers (one module per domain, listed in `src/commands/mod.rs`; `debug` is dev-build only), plus app setup and command registration (`src/main.rs`), the CLI IPC server (`src/ipc.rs`), PTYs, the tray, the remote client and host, and voice. Business logic belongs in the `claudette` crate, never in a command body.

## Checks

CI compiles this crate's tests but never runs them, and never lints it. When you change anything here, run:

```bash
scripts/stage-cli-sidecar.sh --profile debug   # externalBin `binaries/claudette` must exist to build
cargo clippy -p claudette-tauri --all-targets
cargo test -p claudette-tauri <filter>
```

If either check fails on code you didn't touch, check it on plain `origin/main` and report it as pre-existing. `clippy.toml`'s raw `Command::new` ban isn't enforced by CI here, so check new spawn sites by hand (root `AGENTS.md`, Windows specifics).

## Feature flags

- **`default`** is `server`, `voice`, `devtools`, `alternative-backends`.
- **`voice`** adds `cpal`, `candle-*` (Whisper), `tokenizers`, `rubato` and `hound`. Linux needs `libasound2-dev`. Headless builds drop it with `--no-default-features --features tauri/custom-protocol,server`.
- **`server`** adds `claudette-server` for Share this machine.
- **`alternative-backends`** shows Codex Native and the Ollama and OpenAI provider cards in Settings > Models.
- **`devtools`** turns on the Tauri devtools.

## Notification architecture

- Notification sounds and commands run on the Rust side, because macOS suspends webview JS while the window is hidden. A new attention signal handled only in the webview never fires in the background.
- `src/tray.rs` handles attention notifications (AskUserQuestion, ExitPlanMode). `src/commands/chat/` handles agent-finished ones.
- Both go through `build_notification_command` in `src/commands/settings.rs`. That runs `sh -c <cmd>` on macOS and Linux, and `cmd.exe /S /C <cmd>` on Windows.
- Banners use `mac-notification-sys` on macOS (click to navigate) and `tauri-plugin-notification` on Linux and Windows.
- On macOS and Linux, sounds shell out to `afplay`, `paplay` or `ffplay`. On Windows, `claudette::audio` (`src/audio.rs` in the core crate) uses `PlaySoundW` for system sounds and `rodio` for sound packs. New Windows audio code goes in `audio.rs`, so the `unsafe` FFI stays in one place.

## Voice

- Respect the macOS privacy-prompt contract (root `AGENTS.md`).
- Each mic click logs one event on the `claudette::voice` tracing target, with `provider_id`, `total_ms` and `stream_open_ms`. Failed starts log at error level.
- Dev builds also emit `voice://debug/start_latency`.
- See `site/src/content/docs/features/diagnostics.mdx`.

## Debug server (dev builds only)

- Dev builds run a TCP eval server on `127.0.0.1` (default port `19432`, overridable with `$CLAUDETTE_DEBUG_PORT`) that runs JS in the webview.
- It exposes `window.__CLAUDETTE_STORE__` and `window.__CLAUDETTE_INVOKE__`.
- All debug code is gated behind `#[cfg(debug_assertions)]` / `import.meta.env.DEV`.
