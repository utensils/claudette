# Claudette dev launcher — Windows port of `scripts/dev.sh`.
#
# Mirrors the Nix devshell `dev` command (which runs `./scripts/dev.sh`) so a
# single muscle-memory works on Linux/macOS *and* Windows. The .sh original
# can't run on Windows because `bash` here resolves to the WSL launcher and
# the Windows-side `cargo`/`bun`/`tauri` aren't on the WSL distro's PATH.
#
# What this does, in order:
#   1. Parse flags (--clean, --help) — matching dev.sh's surface so muscle
#      memory carries across platforms.
#   2. Refresh PATH from the registry so clang/llvm (Scoop-installed) and
#      cargo are visible — required for `ring` to compile its ARM64 asm.
#   3. Probe a free Vite port (default base 14253) and a free debug-eval port
#      (default base 19432). Same ports as dev.sh so /claudette-debug
#      discovery works the same way on Windows.
#   4. Stage the `claudette-cli` binary at the path Tauri's
#      `bundle.externalBin` expects (`src-tauri/binaries/claudette-<triple>.exe`).
#      Necessary because `tauri.conf.json`'s `beforeDevCommand` script — the
#      .sh that does this on Unix — can't run here. We override
#      `beforeDevCommand` below to bypass that step.
#   5. `bun install` in `src/ui` (cheap if up-to-date).
#   6. Write the per-PID discovery file at `$env:TEMP\claudette-dev\<pid>.json`
#      so /claudette-debug helpers can find this instance.
#   7. Start Vite (forced to 127.0.0.1) and `cargo run` claudette-tauri.
#
# Env overrides (same names as dev.sh):
#   $env:VITE_PORT_BASE             start port for Vite probe (default 14253)
#   $env:CLAUDETTE_DEBUG_PORT_BASE  start port for debug probe (default 19432)
#   $env:CARGO_TAURI_FEATURES       features (default devtools,server,voice,alternative-backends — matches scripts/dev.sh)
#
# Flags:
#   --clean              Run as a fresh user — points CLAUDETTE_HOME,
#                        CLAUDETTE_DATA_DIR, and CLAUDE_CONFIG_DIR at
#                        per-PID tmp dirs so the launch sees no existing
#                        repos, settings, plugins, or Claude auth, and
#                        nothing it does writes back to the real user
#                        state. Cleaned up on exit. See -h for details.
#   -h, --help           Print usage and exit.
#
# Usage from any PowerShell prompt in the repo:
#   .\scripts\dev.ps1
#   .\scripts\dev.ps1 --clean
#   .\scripts\dev.ps1 --help
#
# To get bare `dev` like the Nix devshell, add this to your PowerShell
# profile (`$PROFILE`):
#   function dev {
#       $repo = "C:\Users\brink\Projects\claudette"
#       & "$repo\scripts\dev.ps1" @args
#   }

$ErrorActionPreference = 'Stop'

# 1) Parse flags before doing anything expensive (PATH refresh, port probe,
#    cargo build). Matches dev.sh's surface so `dev --clean` / `dev -h` /
#    `dev --help` work identically on Windows. Unknown args are forwarded
#    to `cargo run` after `--`, mirroring dev.sh's passthrough slot.
function Show-Usage {
    @"
Usage: scripts\dev.ps1 [FLAGS] [-- CARGO_PASSTHROUGH_ARGS...]

Launch the Claudette Tauri dev build with port discovery, sidecar staging,
and the IPv4-bound Vite + custom-protocol-off configuration that Windows
needs for the WebView2 + /claudette-debug combination to work.

Flags:
  --clean              Run as a fresh user — points three env vars at a
                       per-PID tmp tree so the launch sees no existing
                       state and nothing it writes leaks back to the
                       real user:

                         CLAUDETTE_HOME      ~/.claudette/ (workspaces,
                                             themes, logs, packs)
                         CLAUDETTE_DATA_DIR  OS data dir for claudette.db
                         CLAUDE_CONFIG_DIR   ~/.claude/ (Claude CLI
                                             settings, credentials,
                                             plugins, marketplaces)

                       Cleaned up on exit. Useful for testing first-run
                       UX (welcome card, onboarding) and plugin/auth
                       flows without nuking real user data.
  -h, --help           Print this usage and exit.
  --                   Pass everything after this flag straight to
                       ``cargo run`` (e.g. --release, --quiet).

Env vars (each consulted at process start):
  `$env:VITE_PORT_BASE
                       First Vite port to probe.            Default 14253
  `$env:CLAUDETTE_DEBUG_PORT_BASE
                       First debug-eval port to probe.      Default 19432
  `$env:CARGO_TAURI_FEATURES
                       Features to forward to ``cargo run``.
                       Default: devtools,server,voice,alternative-backends
                       (matches scripts/dev.sh / Nix devshell exactly so a
                       single muscle memory works on every host). On
                       aarch64-pc-windows-msvc the dev script appends
                       ``-C target-feature=+fullfp16`` to RUSTFLAGS so
                       ``gemm-f16``'s ARMv8.2 inline asm compiles —
                       existing RUSTFLAGS are preserved (rustc
                       concatenates ``-C target-feature`` directives so
                       multiple sources compose cleanly). See the
                       comment block lower in this script for why.
  `$env:CLAUDETTE_HOME Override the ~/.claudette/ tree (workspaces,
                       plugins, themes, logs, models, packs, apps.json).
  `$env:CLAUDETTE_DATA_DIR
                       Override the OS data dir holding claudette.db.
  `$env:CLAUDE_CONFIG_DIR
                       Override the Claude CLI's ~/.claude/ tree
                       (settings.json, .credentials.json, plugins,
                       marketplaces). Read by both the Claude CLI itself
                       and Claudette's plugin / auth code paths.
  `$env:CLAUDETTE_LOG_DIR
                       Per-instance log dir (otherwise derived from
                       CLAUDETTE_HOME).

Discovery file:
  Each invocation writes `$env:TEMP\claudette-dev\<pid>.json so the
  /claudette-debug skill (and similar tools) find the matching dev
  build when multiple are running. Removed on exit.
"@ | Write-Host
}

$cleanSession = $false
$showHelp = $false
$passthrough = @()
$inPassthrough = $false
foreach ($a in $args) {
    if ($inPassthrough) { $passthrough += $a; continue }
    switch -Exact ($a) {
        '--clean' { $cleanSession = $true }
        '-h'      { $showHelp = $true }
        '--help'  { $showHelp = $true }
        '--'      { $inPassthrough = $true }
        default   { $passthrough += $a }
    }
}

if ($showHelp) {
    Show-Usage
    exit 0
}

# 2) Refresh PATH from the registry. Without this, a fresh PowerShell
#    inherited from before LLVM was installed has no clang on PATH and
#    the `ring` build script fails with `failed to find tool "clang"`.
$machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
$userPath    = [Environment]::GetEnvironmentVariable("PATH", "User")
$env:PATH    = "$machinePath;$userPath"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

# 3) Port probing. PowerShell has no `lsof`; ask the IP global props for
#    every TCP listener on the box and reject any port that already has
#    one. This covers both IPv4 and IPv6 listeners — important because
#    Vite binds on `::1` (IPv6 loopback) on Windows and a 127.0.0.1-only
#    bind probe was happy to call the port "free" while Vite was about
#    to fail with "Port 14253 is already in use". Using the property
#    table also avoids the brief listener-bind race that the previous
#    TcpListener::Start/Stop probe introduced.
function Test-PortFree {
    param([int]$Port)
    $globalProps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $listeners = $globalProps.GetActiveTcpListeners()
    foreach ($listener in $listeners) {
        if ($listener.Port -eq $Port) { return $false }
    }
    return $true
}

function Find-FreePort {
    param([int]$Start)
    $p = $Start
    while (-not (Test-PortFree -Port $p)) { $p++ }
    return $p
}

$viteBase  = if ($env:VITE_PORT_BASE)            { [int]$env:VITE_PORT_BASE }            else { 14253 }
$debugBase = if ($env:CLAUDETTE_DEBUG_PORT_BASE) { [int]$env:CLAUDETTE_DEBUG_PORT_BASE } else { 19432 }

$vitePort  = Find-FreePort -Start $viteBase
$debugPort = Find-FreePort -Start $debugBase

$env:VITE_PORT             = $vitePort
$env:CLAUDETTE_DEBUG_PORT  = $debugPort

# 4) Resolve the host triple — the staged sidecar's filename has to match
#    the value Tauri stamps into `TAURI_ENV_TARGET_TRIPLE` at build time
#    (looked up via `bundle.externalBin`).
$tripleLine = (& rustc -vV) | Select-String -Pattern '^host:\s*(.+)$'
if (-not $tripleLine) {
    Write-Error "Could not determine rustc host triple from 'rustc -vV'"
    exit 1
}
$triple = $tripleLine.Matches[0].Groups[1].Value.Trim()

$branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
if (-not $branch) { $branch = 'unknown' }

Write-Host "▸ Branch:           $branch"
Write-Host "▸ Triple:           $triple"
Write-Host "▸ Vite dev server:  http://localhost:$vitePort"
Write-Host "▸ Debug eval port:  $debugPort"

# Stage debug sidecar. dev.sh delegates to scripts/stage-cli-sidecar.sh; we
# inline the equivalent because the .sh can't run on Windows.
Write-Host "▸ Building claudette-cli (debug) for $triple"
& cargo build -p claudette-cli
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$srcExe = Join-Path $repoRoot 'target\debug\claudette.exe'
if (-not (Test-Path $srcExe)) {
    Write-Error "claudette-cli build did not produce $srcExe"
    exit 66
}
$destDir = Join-Path $repoRoot 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$destExe = Join-Path $destDir "claudette-$triple.exe"
Copy-Item $srcExe $destExe -Force
Write-Host "▸ Staged sidecar:   $destExe"

# 5) `bun install` so a fresh clone has node_modules before Vite
#    starts. Mirrors dev.sh's explicit pre-install pass. Unlike dev.sh
#    we *don't* also get a second pass from `tauri.conf.json`'s
#    `beforeDevCommand` because step 7 below bypasses `cargo tauri
#    dev` entirely (see the long-form comment there for why), so this
#    step is the only install. `--frozen-lockfile` matches CI and
#    fails fast if `bun.lock` drifted.
Write-Host "▸ bun install       (cd src/ui)"
$bunInstall = Start-Process bun `
    -ArgumentList @('install', '--frozen-lockfile') `
    -WorkingDirectory (Join-Path $repoRoot 'src\ui') `
    -NoNewWindow -Wait -PassThru
if ($bunInstall.ExitCode -ne 0) {
    Write-Error "bun install failed (exit $($bunInstall.ExitCode))"
    exit $bunInstall.ExitCode
}

# 6) Discovery file — same shape as dev.sh's so /claudette-debug picks
#    up Windows dev instances identically. Use $env:TEMP since
#    $TMPDIR isn't set on Windows by default.
$discoveryDir = Join-Path $env:TEMP 'claudette-dev'
New-Item -ItemType Directory -Force -Path $discoveryDir | Out-Null
$discoveryFile = Join-Path $discoveryDir "$PID.json"

$started = [int][Math]::Floor(((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)
$discoveryPayload = [ordered]@{
    pid        = $PID
    debug_port = $debugPort
    vite_port  = $vitePort
    cwd        = $repoRoot
    branch     = $branch
    started_at = $started
} | ConvertTo-Json -Compress
# Set-Content -Encoding utf8 emits a UTF-8 BOM on Windows PowerShell 5.1
# (only pwsh 6+ defaults to no-BOM). debug-eval.sh on Windows reads this
# file via `python3 json.load`, which doesn't strip BOMs and chokes at
# byte 0 with `Expecting value`. Write the file via .NET with an
# explicit no-BOM UTF-8 encoder so output is byte-identical on PS 5.1
# and pwsh 7+.
[IO.File]::WriteAllText(
    $discoveryFile,
    $discoveryPayload,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "▸ Discovery file:   $discoveryFile"

# --clean: per-PID sandbox so a parallel `dev --clean` doesn't reuse this
# session's state. Mirrors dev.sh's clean_root layout under the same
# discovery dir so the cleanup sweep finds it predictably. The trap
# below removes the directory on script exit; a hard kill leaves it
# behind, but it's under $env:TEMP so it won't leak forever.
#
# Three env vars get pointed at the sandbox — only the first two are
# Claudette-specific:
#
#   CLAUDETTE_HOME      ~/.claudette/ tree (workspaces, themes, logs, packs)
#   CLAUDETTE_DATA_DIR  OS data dir holding claudette.db
#   CLAUDE_CONFIG_DIR   ~/.claude/ tree, owned by the *Claude CLI* but
#                       actively read+written by Claudette: settings.json,
#                       .credentials.json, plugins/, plugins/marketplaces/.
#                       Without this, a --clean run that touches plugins,
#                       auth, or marketplaces writes those changes into
#                       the user's real ~/.claude/, defeating the
#                       "simulate a new user" purpose of the flag.
#
# Env-var lifetime: when this script is invoked from an interactive
# PowerShell prompt (the common case via the `dev` profile function),
# `$env:NAME = ...` mutates the *caller's* process environment because
# `&` runs the script in the same process. Without restoring the
# original values on exit, the user's shell would still have
# CLAUDE_CONFIG_DIR / CLAUDETTE_HOME / CLAUDETTE_DATA_DIR pointing at
# the now-deleted clean root after `dev --clean` completes — silently
# affecting any subsequent Claudette CLI usage from that prompt. We
# therefore snapshot the prior values (or absence) up front and put
# the unset/restore in the same PowerShell.Exiting handler that
# removes the temp tree.
$cleanRoot = $null
$prevClaudetteHome     = $null
$prevClaudetteDataDir  = $null
$prevClaudeConfigDir   = $null
$cleanSandboxEnvVars   = $false
if ($cleanSession) {
    $cleanRoot = Join-Path $discoveryDir "clean-$PID"
    $prevClaudetteHome    = if (Test-Path Env:\CLAUDETTE_HOME)     { $env:CLAUDETTE_HOME }     else { $null }
    $prevClaudetteDataDir = if (Test-Path Env:\CLAUDETTE_DATA_DIR) { $env:CLAUDETTE_DATA_DIR } else { $null }
    $prevClaudeConfigDir  = if (Test-Path Env:\CLAUDE_CONFIG_DIR)  { $env:CLAUDE_CONFIG_DIR }  else { $null }
    $cleanSandboxEnvVars  = $true
    $env:CLAUDETTE_HOME      = Join-Path $cleanRoot 'home'
    $env:CLAUDETTE_DATA_DIR  = Join-Path $cleanRoot 'data'
    $env:CLAUDE_CONFIG_DIR   = Join-Path $cleanRoot 'claude-config'
    New-Item -ItemType Directory -Force -Path $env:CLAUDETTE_HOME | Out-Null
    New-Item -ItemType Directory -Force -Path $env:CLAUDETTE_DATA_DIR | Out-Null
    New-Item -ItemType Directory -Force -Path $env:CLAUDE_CONFIG_DIR | Out-Null
    Write-Host "▸ Clean session:      $cleanRoot"
    Write-Host "▸ CLAUDETTE_HOME:     $env:CLAUDETTE_HOME"
    Write-Host "▸ CLAUDETTE_DATA_DIR: $env:CLAUDETTE_DATA_DIR"
    Write-Host "▸ CLAUDE_CONFIG_DIR:  $env:CLAUDE_CONFIG_DIR"
}

# Best-effort cleanup. PowerShell can't trap SIGTERM/SIGINT identically
# to bash; PowerShell.Exiting fires for clean exits and most Ctrl-C
# scenarios. A killed -9 still leaves the file behind, but the file is
# tiny and per-PID so a stale one is harmless.
# Build the cleanup body via -f so we don't have to deal with the
# here-string's column-0 termination requirement (PowerShell rejects
# `"@` with any leading whitespace, which fights `scripts/` indent).
# Use a string fallback rather than `??` so the script parses in
# Windows PowerShell 5.1 (no null-coalescing) as well as pwsh 7+.
#
# The env-var section restores each of the three sandbox vars to its
# pre-launch value (or removes it entirely if it wasn't set), so the
# caller's PowerShell session is left exactly as it was before
# `dev --clean` ran. Sentinel literal `__UNSET__` rides through the
# format string to distinguish "wasn't set" from "was set to empty
# string" — both legal pre-states, but they need different handling.
$cleanRootForCleanup = if ($null -eq $cleanRoot) { '' } else { $cleanRoot }
$envScrubFlag        = if ($cleanSandboxEnvVars) { '1' } else { '' }
$prevHomeForCleanup       = if ($null -eq $prevClaudetteHome)    { '__UNSET__' } else { $prevClaudetteHome }
$prevDataDirForCleanup    = if ($null -eq $prevClaudetteDataDir) { '__UNSET__' } else { $prevClaudetteDataDir }
$prevConfigDirForCleanup  = if ($null -eq $prevClaudeConfigDir)  { '__UNSET__' } else { $prevClaudeConfigDir }
$cleanupBody = @'
if (Test-Path -LiteralPath '{0}') {{
    Remove-Item -LiteralPath '{0}' -Force -ErrorAction SilentlyContinue
}}
if ('{1}' -ne '' -and (Test-Path -LiteralPath '{1}')) {{
    Remove-Item -LiteralPath '{1}' -Recurse -Force -ErrorAction SilentlyContinue
}}
if ('{2}' -ne '') {{
    if ('{3}' -eq '__UNSET__') {{ Remove-Item Env:\CLAUDETTE_HOME -ErrorAction SilentlyContinue }}
    else {{ $env:CLAUDETTE_HOME = '{3}' }}
    if ('{4}' -eq '__UNSET__') {{ Remove-Item Env:\CLAUDETTE_DATA_DIR -ErrorAction SilentlyContinue }}
    else {{ $env:CLAUDETTE_DATA_DIR = '{4}' }}
    if ('{5}' -eq '__UNSET__') {{ Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }}
    else {{ $env:CLAUDE_CONFIG_DIR = '{5}' }}
}}
'@ -f $discoveryFile, $cleanRootForCleanup, $envScrubFlag,
       $prevHomeForCleanup, $prevDataDirForCleanup, $prevConfigDirForCleanup
$cleanupAction = [ScriptBlock]::Create($cleanupBody)
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanupAction | Out-Null

# 7) Start Vite + run the Tauri binary in debug mode.
#
# Why this differs from dev.sh:
#
#   * dev.sh uses `cargo tauri dev`, which on Windows is unusable here:
#     tauri-cli 2.11.1 always merges the package's [features].default
#     into the resulting `cargo run` invocation, even when -f is passed.
#     We bypass tauri-cli by driving `bun run dev` + `cargo run` ourselves
#     so we can drop `tauri/custom-protocol` (see the third bullet) and
#     keep `--no-default-features` honored verbatim.
#
#   * Vite must bind on `127.0.0.1` (IPv4), not its default `localhost`
#     which on Windows resolves to `::1` (IPv6). WebView2 navigates to
#     `http://localhost:14253`, IPv4 first by default. If Vite is on
#     `::1` only, controller creation fails with HRESULT 0x80070057
#     ("The parameter is incorrect.") and the binary stays alive with
#     an empty window. Passing `-- --host 127.0.0.1` to Vite forces
#     the v4 bind and the webview connects cleanly.
#
#   * `tauri/custom-protocol` is intentionally NOT enabled. With it
#     on, Tauri's build.rs sets `cfg(dev) = false`, the binary loads
#     embedded HTML instead of devUrl, AND `import.meta.env.DEV` in
#     the frontend is false — which leaves `window.__CLAUDETTE_INVOKE__`
#     unset, breaking the `/claudette-debug` TCP eval server. We want
#     hot-reload AND the eval server, so we keep Vite + dev URL.
#
# Feature parity with scripts/dev.sh: both default to
# `devtools,server,voice,alternative-backends`. On aarch64-pc-windows-msvc
# the `voice` feature pulls in `candle-*` → `gemm-f16`, whose ARMv8.2
# inline asm (`fmla v0.8h, ..., fmul v0.8h, ...`) needs the `fullfp16`
# target feature that the stock baseline doesn't enable. Compile fails
# with `instruction requires: fullfp16` otherwise. We auto-add
# `-C target-feature=+fullfp16` to RUSTFLAGS just below when the host
# triple matches, so a fresh Windows ARM64 user can run `dev` with no
# extra knobs and still get voice. x86_64 hosts and pre-set RUSTFLAGS
# pass through unchanged.
$features = if ($env:CARGO_TAURI_FEATURES) { $env:CARGO_TAURI_FEATURES }
            else { 'devtools,server,voice,alternative-backends' }

# Auto-enable fullfp16 on aarch64-pc-windows-msvc when `voice` is in the
# feature set: gemm-f16's ARMv8.2 inline asm requires it, and the stock
# baseline doesn't.
#
# Important: rustc concatenates rustflags from *every* `-C target-feature`
# directive, so appending our flag to an existing RUSTFLAGS works
# correctly — it doesn't clobber the user's own flags. Earlier revisions
# only injected when RUSTFLAGS was unset, which silently broke the build
# for anyone who had RUSTFLAGS set for unrelated reasons (e.g. `-Dwarnings`
# from a prior shell). If the user has already added `+fullfp16`
# themselves, we skip to avoid a duplicate directive in the log.
$needFullFp16 = $triple -eq 'aarch64-pc-windows-msvc' -and $features -match 'voice'
if ($needFullFp16 -and $env:RUSTFLAGS -notmatch 'target-feature=\+fullfp16') {
    if ($env:RUSTFLAGS) {
        $env:RUSTFLAGS = "$env:RUSTFLAGS -C target-feature=+fullfp16"
        Write-Host "▸ RUSTFLAGS:        $env:RUSTFLAGS  (appended +fullfp16 for ARM64 voice build)"
    } else {
        $env:RUSTFLAGS = '-C target-feature=+fullfp16'
        Write-Host "▸ RUSTFLAGS:        $env:RUSTFLAGS  (auto-added for ARM64 voice build)"
    }
} elseif ($env:RUSTFLAGS) {
    Write-Host "▸ RUSTFLAGS:        $env:RUSTFLAGS  (preserved from environment)"
}

Write-Host "▸ Features:         $features"
Write-Host "▸ Starting Vite     (cd src/ui; bun run dev -- --host 127.0.0.1)"

# Vite needs --host 127.0.0.1 to force an IPv4 bind. Default on Windows
# is `::1` (IPv6) which WebView2 cannot reach via `http://localhost:...`
# without a corresponding A record — see comment block above.
$viteLog = Join-Path $repoRoot '.claude-tmp\vite-out.log'
New-Item -ItemType Directory -Force -Path (Split-Path $viteLog) | Out-Null
$viteProc = Start-Process bun `
    -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1') `
    -WorkingDirectory (Join-Path $repoRoot 'src\ui') `
    -RedirectStandardOutput $viteLog `
    -RedirectStandardError "$viteLog.err" `
    -PassThru -WindowStyle Hidden

Write-Host "▸ Vite pid:         $($viteProc.Id)  (log: $viteLog)"

# Tear down Vite when this script exits — orphan node processes hold
# the port and break the next `dev`. Build the cleanup body via -f-style
# string concatenation so $viteId expands once at registration; the
# `$_` is backtick-escaped so it stays as ForEach-Object's pipeline
# variable inside the resulting ScriptBlock.
$viteId = $viteProc.Id
$cleanupCmd = "Stop-Process -Id $viteId -Force -ErrorAction SilentlyContinue; " +
              "Get-CimInstance Win32_Process -Filter `"ParentProcessId = $viteId`" -ErrorAction SilentlyContinue | " +
              "ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }"
Register-EngineEvent -SourceIdentifier PowerShell.Exiting `
    -Action ([ScriptBlock]::Create($cleanupCmd)) | Out-Null

# Wait until Vite is actually listening on the port. Use
# GetActiveTcpListeners so we see both IPv4 and IPv6 listeners — see
# the analogous comment on Find-FreePort above for why a TcpClient
# probe to 127.0.0.1 isn't sufficient.
Write-Host "▸ Waiting for Vite to bind localhost:$vitePort"
$deadline = (Get-Date).AddSeconds(60)
$ready = $false
$globalProps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
while ((Get-Date) -lt $deadline) {
    $listeners = $globalProps.GetActiveTcpListeners()
    foreach ($listener in $listeners) {
        if ($listener.Port -eq $vitePort) {
            $ready = $true
            break
        }
    }
    if ($ready) { break }
    if ($viteProc.HasExited) {
        Write-Error "Vite exited prematurely (code $($viteProc.ExitCode)). See $viteLog"
        exit 1
    }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) {
    Write-Error "Vite did not bind localhost:$vitePort within 60s. See $viteLog"
    Stop-Process -Id $viteProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "▸ Vite ready"

Write-Host "▸ Launching claudette-app (debug; first build is slow, incremental builds are fast)"
if ($passthrough.Count -gt 0) {
    Write-Host "▸ Passthrough args: $($passthrough -join ' ')"
}
Write-Host ""

& cargo run -p claudette-tauri --no-default-features --features $features @passthrough
$cargoExit = $LASTEXITCODE

# Best-effort cleanup so the next `dev` doesn't hit "Port 14253 in use".
Get-CimInstance Win32_Process -Filter "ParentProcessId = $($viteProc.Id)" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $viteProc.Id -Force -ErrorAction SilentlyContinue

exit $cargoExit
