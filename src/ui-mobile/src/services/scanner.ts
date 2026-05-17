// QR scanner thin wrapper. The barcode-scanner Tauri plugin is mobile-only
// (iOS / Android). On the desktop fallback build the import fails at
// runtime — we catch that and let the caller fall back to the paste UI.
//
// The plugin module is memoized so `isScannerAvailable` (called on every
// ConnectScreen mount) doesn't re-load and re-evaluate the module each
// time. On iOS that re-evaluation has measurable startup cost; on
// desktop it's wasted work that flips between availability states.

interface ScanResult {
  content: string;
}

interface ScannerModule {
  scan: (opts: { formats: unknown[] }) => Promise<ScanResult>;
  Format: { QRCode: unknown };
}

// `null` = haven't tried yet; `false` = tried and unavailable; otherwise
// the resolved module. We memoize the promise (not the resolved value)
// so concurrent first calls share the import without racing.
let scannerModulePromise: Promise<ScannerModule | null> | null = null;

function loadScannerModule(): Promise<ScannerModule | null> {
  if (scannerModulePromise !== null) return scannerModulePromise;
  scannerModulePromise = (async () => {
    try {
      const mod = (await import(
        "@tauri-apps/plugin-barcode-scanner"
        /* @vite-ignore */
      )) as ScannerModule;
      return mod;
    } catch (err) {
      console.warn("Barcode scanner unavailable:", err);
      return null;
    }
  })();
  return scannerModulePromise;
}

export async function scanQr(): Promise<string | null> {
  const mod = await loadScannerModule();
  if (!mod) return null;
  try {
    // The plugin's `scan` accepts a list of formats. QR is the only
    // one we care about — accepting more formats would let someone
    // pair a Claudette server by scanning a barcode on a soup can.
    const result = await mod.scan({ formats: [mod.Format.QRCode] });
    return result?.content ?? null;
  } catch (err) {
    console.warn("Barcode scan failed:", err);
    return null;
  }
}

export async function isScannerAvailable(): Promise<boolean> {
  return (await loadScannerModule()) !== null;
}
