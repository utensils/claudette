# Windows screenshot helper for the claudette-debug skill.
#
# Captures the entire virtual screen (all monitors) to PNG using
# System.Drawing — no third-party tooling required. Called from
# debug-screenshot.sh on MSYS/Git-Bash hosts, or invoked directly
# from native PowerShell:
#
#   .\debug-screenshot.ps1 --output C:\path\to\out.png
#
# Prints the absolute output path to stdout. Mirrors the bash
# version's interface (single `--output` flag) so callers don't need
# to branch.
[CmdletBinding()]
param(
    [Parameter()]
    [string]$Output
)

# Hand-roll the arg parsing to match debug-screenshot.sh's `--output PATH`
# convention (rather than PowerShell's native `-Output PATH`). The bash
# wrapper passes args verbatim, so PowerShell sees `--output` literally.
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '--output' -and ($i + 1) -lt $args.Count) {
        $Output = $args[$i + 1]
        $i++
    }
}

$ErrorActionPreference = 'Stop'

if (-not $Output) {
    $dir = Join-Path $env:TEMP 'claudette-debug'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = [int][Math]::Floor(((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)
    $Output = Join-Path $dir "screenshot-$stamp.png"
}

# Make sure the parent directory exists. Caller may pass an absolute
# path under a not-yet-created subdir.
$parent = Split-Path -Parent $Output
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

# System.Drawing is shipped with Windows PowerShell and modern
# pwsh on Windows (the latter ships it as a separate assembly that
# Add-Type loads from the GAC). On Linux/macOS pwsh it's missing —
# but this script is Windows-only so that's not a concern.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Use the virtual screen so multi-monitor setups capture every
# display, matching macOS `screencapture -x` (full screen) and
# Linux `import -window root` (root window). SystemInformation
# gives us the rectangle in pixels.
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = $null
$graphics = $null
try {
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
}

# Print the resolved path. Callers (debug-screenshot.sh) discard
# this and print the bash-side path instead, but native pwsh users
# get a result they can pipe into `Read`.
Write-Output (Resolve-Path -LiteralPath $Output).Path
