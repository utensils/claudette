// QR scanner thin wrapper. The barcode-scanner Tauri plugin is mobile-only
// (iOS / Android). On the desktop fallback build the import fails at
// runtime — we catch that and let the caller fall back to the paste UI.

interface ScanResult {
  content: string;
}

export async function scanQr(): Promise<string | null> {
  try {
    const mod = await import(
      "@tauri-apps/plugin-barcode-scanner"
      /* @vite-ignore */
    );
    // The plugin's `scan` accepts a list of formats. `QR_CODE` is the
    // only one we care about — accepting more formats would let someone
    // pair a Claudette server by scanning a barcode on a soup can.
    const result = (await mod.scan({
      formats: [mod.Format.QRCode],
    })) as ScanResult;
    return result?.content ?? null;
  } catch (err) {
    console.warn("Barcode scanner unavailable:", err);
    return null;
  }
}

export async function isScannerAvailable(): Promise<boolean> {
  try {
    await import("@tauri-apps/plugin-barcode-scanner" /* @vite-ignore */);
    return true;
  } catch {
    return false;
  }
}
