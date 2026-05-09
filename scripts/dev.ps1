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

# 2) Port probing. PowerShell has no `lsof`; bind a TcpListener on
#    127.0.0.1:<port> to test availability — succeeds iff nothing is
#    listening on that port. Stop() releases the bind immediately so the
#    real Vite/debug servers can claim the port a moment later.
function Test-PortFree {
    param([int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
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

# 4) bun install (cheap if up-to-date).
Push-Location (Join-Path $repoRoot 'src\ui')
try {
    & bun install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

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

# 6) Launch Tauri.
$features = if ($env:CARGO_TAURI_FEATURES) { $env:CARGO_TAURI_FEATURES }
            else { 'devtools,server,voice,alternative-backends' }

# Override `beforeDevCommand` to drop the `.sh` invocation that
# tauri.conf.json ships for Unix devs. The remaining
# `bun install && bun run dev` is portable: cmd /C parses && fine and
# bun lives on PATH. We also pin `devUrl` to the probed port so the
# webview connects to whatever Vite actually bound.
$confOverride = @{
    build = @{
        devUrl            = "http://localhost:$vitePort"
        beforeDevCommand  = @{
            script = 'bun install && bun run dev'
            cwd    = '../src/ui'
        }
    }
} | ConvertTo-Json -Compress -Depth 5

Write-Host "▸ Features:         $features"
Write-Host "▸ Launching cargo tauri dev"
Write-Host ""

& cargo tauri dev --features $features -c $confOverride
exit $LASTEXITCODE
