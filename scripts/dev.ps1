# Claudette dev launcher — Windows port of `scripts/dev.sh`.
#
# Mirrors the Nix devshell `dev` command (which runs `./scripts/dev.sh`) so a
# single muscle-memory works on Linux/macOS *and* Windows. The .sh original
# can't run on Windows because `bash` here resolves to the WSL launcher and
# the Windows-side `cargo`/`bun`/`tauri` aren't on the WSL distro's PATH.
#
# What this does, in order:
#   1. Refresh PATH from the registry so clang/llvm (Scoop-installed) and
#      cargo are visible — required for `ring` to compile its ARM64 asm.
#   2. Probe a free Vite port (default base 14253) and a free debug-eval port
#      (default base 19432). Same ports as dev.sh so /claudette-debug
#      discovery works the same way on Windows.
#   3. Stage the `claudette-cli` binary at the path Tauri's
#      `bundle.externalBin` expects (`src-tauri/binaries/claudette-<triple>.exe`).
#      Necessary because `tauri.conf.json`'s `beforeDevCommand` script — the
#      .sh that does this on Unix — can't run here. We override
#      `beforeDevCommand` below to bypass that step.
#   4. `bun install` in `src/ui` (cheap if up-to-date).
#   5. Write the per-PID discovery file at `$env:TEMP\claudette-dev\<pid>.json`
#      so /claudette-debug helpers can find this instance.
#   6. `cargo tauri dev` with the chosen features and a config override that
#      (a) replaces `beforeDevCommand` with a portable `bun install &&
#      bun run dev` (no .sh), and (b) points `devUrl` at the probed port.
#
# Env overrides (same names as dev.sh):
#   $env:VITE_PORT_BASE             start port for Vite probe (default 14253)
#   $env:CLAUDETTE_DEBUG_PORT_BASE  start port for debug probe (default 19432)
#   $env:CARGO_TAURI_FEATURES       features (default devtools,server,voice,alternative-backends)
#
# Usage from any PowerShell prompt in the repo:
#   .\scripts\dev.ps1
#
# To get bare `dev` like the Nix devshell, add this to your PowerShell
# profile (`$PROFILE`):
#   function dev {
#       $repo = "C:\Users\brink\Projects\claudette"
#       & "$repo\scripts\dev.ps1" @args
#   }

$ErrorActionPreference = 'Stop'

# 1) Refresh PATH from the registry. Without this, a fresh PowerShell
#    inherited from before LLVM was installed has no clang on PATH and
#    the `ring` build script fails with `failed to find tool "clang"`.
$machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
$userPath    = [Environment]::GetEnvironmentVariable("PATH", "User")
$env:PATH    = "$machinePath;$userPath"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

# 2) Port probing. PowerShell has no `lsof`; ask the IP global props for
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

# 3) Resolve the host triple — the staged sidecar's filename has to match
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

# 4) `bun install` runs as part of the `beforeDevCommand` override
#    below, so we don't need a separate pass here. Kept the original
#    dev.sh's pre-install step out so a fresh checkout doesn't bun
#    install twice every time.

# 5) Discovery file — same shape as dev.sh's so /claudette-debug picks
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
Set-Content -Path $discoveryFile -Value $discoveryPayload -Encoding utf8 -NoNewline

Write-Host "▸ Discovery file:   $discoveryFile"

# Best-effort cleanup. PowerShell can't trap SIGTERM/SIGINT identically
# to bash; PowerShell.Exiting fires for clean exits and most Ctrl-C
# scenarios. A killed -9 still leaves the file behind, but the file is
# tiny and per-PID so a stale one is harmless.
# Build the cleanup body via -f so we don't have to deal with the
# here-string's column-0 termination requirement (PowerShell rejects
# `"@` with any leading whitespace, which fights `scripts/` indent).
$cleanupBody = @'
if (Test-Path -LiteralPath '{0}') {{
    Remove-Item -LiteralPath '{0}' -Force -ErrorAction SilentlyContinue
}}
'@ -f $discoveryFile
$cleanupAction = [ScriptBlock]::Create($cleanupBody)
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanupAction | Out-Null

# 6) Start Vite + run the Tauri binary in debug mode.
#
# Why this differs from dev.sh:
#
#   * dev.sh uses `cargo tauri dev`, which on Windows is unusable here:
#     tauri-cli 2.11.1 always merges the package's [features].default
#     into the resulting `cargo run` invocation, even when -f is passed.
#     That drags in `voice` → `candle-*` → `gemm-f16`, whose ARMv8.2
#     inline asm (`fmla v0.8h, ..., fmul v0.8h, ...`) requires the
#     `fullfp16` target feature that aarch64-pc-windows-msvc's
#     baseline does not enable. Debug profile compile fails with
#     `instruction requires: fullfp16`. We bypass tauri-cli by driving
#     `bun run dev` + `cargo run` ourselves.
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
# The Tauri binary is launched via `cargo run -p claudette-tauri
# --no-default-features --features devtools,server,alternative-backends`
# (no `--release`, no custom-protocol, no voice). With Vite already up
# at 127.0.0.1:14253, the webview connects on first paint, the bundle
# loads with `import.meta.env.DEV = true`, `__CLAUDETTE_INVOKE__` gets
# set, and `/claudette-debug` works.
$features = if ($env:CARGO_TAURI_FEATURES) { $env:CARGO_TAURI_FEATURES }
            else { 'devtools,server,alternative-backends' }

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
Write-Host ""

& cargo run -p claudette-tauri --no-default-features --features $features
$cargoExit = $LASTEXITCODE

# Best-effort cleanup so the next `dev` doesn't hit "Port 14253 in use".
Get-CimInstance Win32_Process -Filter "ParentProcessId = $($viteProc.Id)" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $viteProc.Id -Force -ErrorAction SilentlyContinue

exit $cargoExit
