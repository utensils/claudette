
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public class ClaudetteIcon {
    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx, cy; }

    [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemImageFactory {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bc,
        ref Guid riid,
        [Out, MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

    public static byte[] ShellImage(string path, int size) {
        Guid iid = new Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B");
        IShellItemImageFactory factory;
        int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory);
        if (hr != 0) return null;
        IntPtr hbm;
        SIZE sz; sz.cx = size; sz.cy = size;
        hr = factory.GetImage(sz, 0x4 | 0x1, out hbm);
        if (hr != 0) return null;
        try {
            using (Bitmap bmp = Bitmap.FromHbitmap(hbm))
            using (Bitmap argb = new Bitmap(bmp.Width, bmp.Height, PixelFormat.Format32bppArgb)) {
                using (Graphics g = Graphics.FromImage(argb)) g.DrawImage(bmp, 0, 0);
                using (MemoryStream ms = new MemoryStream()) {
                    argb.Save(ms, ImageFormat.Png);
                    return ms.ToArray();
                }
            }
        } finally { DeleteObject(hbm); }
    }

    public static byte[] AssociatedIcon(string path) {
        using (Icon ico = Icon.ExtractAssociatedIcon(path)) {
            if (ico == null) return null;
            using (Bitmap bmp = ico.ToBitmap())
            using (MemoryStream ms = new MemoryStream()) {
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing | Out-Null
$pkg  = [Console]::In.ReadLine()
$path = [Console]::In.ReadLine()

# UWP path: read the AppxManifest to learn the *declared* logo
# (any of the Square*Logo / Logo entries), then glob the same
# directory for size-variant siblings (`Square44x44Logo.targetsize-256.png`,
# `*.scale-400.png`, …) and keep the largest. The declared filename
# rarely exists on disk by itself — Windows splits each logo into
# one PNG per scale + target size at install time, leaving only the
# variants. We filter out `altform-unplated` (transparent badges
# that look wrong on a dark menu background) and `contrast-` (high-
# contrast accessibility variants). File size is the biggest-icon
# heuristic — UWP logos are anti-aliased PNGs whose byte count
# scales with pixel count.
#
# `Get-AppxPackageManifest` works for unprivileged users, and
# `Get-ChildItem` *can* enumerate per-package install dirs under
# `%PROGRAMFILES%\WindowsApps` despite the parent being locked
# down — each package's ACL grants the user list rights to its own
# subtree.
if (-not [string]::IsNullOrEmpty($pkg)) {
    $appx = Get-AppxPackage -Name "${pkg}*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($appx) {
        $manifest = $null
        try { $manifest = Get-AppxPackageManifest -Package $appx.PackageFullName -ErrorAction Stop } catch { }
        $logoRels = @()
        if ($manifest) {
            $vis = $manifest.Package.Applications.Application.VisualElements
            if ($vis) {
                foreach ($attr in 'Square150x150Logo','Square44x44Logo','Square71x71Logo','Logo') {
                    $val = $vis.$attr
                    if ($val) { $logoRels += $val }
                }
            }
            $propLogo = $manifest.Package.Properties.Logo
            if ($propLogo) { $logoRels += $propLogo }
        }
        # Last-resort guesses if the manifest didn't yield anything
        # parseable. Most UWP packages put logos under one of these.
        if ($logoRels.Count -eq 0) { $logoRels = @('Images\Logo.png','Assets\Logo.png') }
        $best = $null
        foreach ($rel in $logoRels) {
            $fullRel = Join-Path $appx.InstallLocation $rel
            $stem = [IO.Path]::GetFileNameWithoutExtension($fullRel)
            $dir  = [IO.Path]::GetDirectoryName($fullRel)
            if (-not (Test-Path $dir)) { continue }
            $candidate = Get-ChildItem -Path $dir -Filter "$stem*.png" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '(?i)altform-unplated|contrast-' } |
                Sort-Object Length -Descending |
                Select-Object -First 1
            if ($candidate -and (-not $best -or $candidate.Length -gt $best.Length)) {
                $best = $candidate
            }
        }
        if ($best) {
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($best.FullName))
            exit 0
        }
    }
}

if ([string]::IsNullOrEmpty($path)) { exit 2 }
$bytes = [ClaudetteIcon]::ShellImage($path, 256)
if ($null -eq $bytes -or $bytes.Length -eq 0) {
    $bytes = [ClaudetteIcon]::AssociatedIcon($path)
}
if ($null -eq $bytes -or $bytes.Length -eq 0) { exit 3 }
[Convert]::ToBase64String($bytes)
