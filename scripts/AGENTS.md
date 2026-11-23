# Scripts and platform tooling

## Dev launcher (`dev.sh`, `dev.ps1` on Windows)

Always launch the app this way: `make dev` (pass flags as `ARGS=--new`), or the script directly. Not with bare `cargo tauri dev`. `make run` is an alias of `make dev`.

- **Ports:** it probes free Vite and debug-eval ports (bases `14253` / `19432`). Vite runs with `strictPort: true`, so a race between the probe and Vite fails loudly. The base moved off Tauri's stock 1420 because other templates' dev scripts can rebind that port under a running webview.
- **Discovery file:** it writes `${TMPDIR:-/tmp}/claudette-dev/<pid>.json` so the `claudette-debug` skill finds the right instance.
- **Sidecar:** it stages the CLI sidecar with `stage-cli-sidecar.sh`.
- **macOS signing:** on macOS it adds `--runner macos-dev-app-runner.sh`, which wraps the build in a signed `.app` (using `src-tauri/Entitlements.plist`) so TCC grants mic and speech permission to Claudette, not your terminal. It also mirrors the sidecars into `Contents/MacOS/`, matching release.
- **Features:** the default is `devtools,server,voice,alternative-backends`. Override with `$CARGO_TAURI_FEATURES`; `alternative-backends` is always appended.
- **State isolation:** by default it uses your real `~/.claudette/` and `claudette.db`.
  - `--new` runs as a fresh, throwaway user.
  - `--clone` runs on an rsync'd snapshot of your real state. Git operations in cloned workspaces still hit the real repositories.
  - Use one of the two on any branch that adds a migration.
  - `--clean` deletes every sandbox under `${TMPDIR:-/tmp}/claudette-dev/`, including those of running sessions.

## mise (non-Nix setup)

- `mise.toml` pins `rust = "1.94"`, `bun = "latest"`, and `tauri-cli` from npm.
- `make setup` runs `mise trust` + `mise install` (skipped inside the Nix devshell), `bun install` and `cargo fetch`. Other make targets run through `mise exec` automatically when mise is installed and you're not in the Nix devshell. Override with `make RUN= <target>`.
- The Nix devshell's `check`, `fmt`, `run-tests`, `coverage` and `docs-dev` commands delegate to make targets, so both paths run the same commands.
- On macOS, `mise.toml` forces `CC=/usr/bin/cc` and per-target Cargo linkers so `-liconv` / `-lSystem` links succeed under `nix-darwin`'s `ld`. Leave those entries alone unless you're fixing them.

## Windows

- **Cross-compile** (Nix devshell):
  - `build-win-arm64` / `build-win-x64` use `cargo xwin` and need `XWIN_ACCEPT_LICENSE=1`.
  - `deploy-win-arm64` / `deploy-win-x64` build and push to the test VM.
- **Ephemeral EC2** (Nix devshell):
  - `aws-win-spinup`, `aws-win-rdp` and `aws-win-destroy` manage the instance.
  - State lives in `.claudette/aws-win/`.
  - Defaults are `AWS_PROFILE=dev.urandom.io` and `AWS_REGION=us-west-2`.
- **CI, nightly and release** build Windows as a zipped bare `.exe` (`cargo xwin build --release --features tauri/custom-protocol`). macOS produces `.dmg`; Linux produces `.AppImage` and `.deb`.
