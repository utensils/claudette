// Defense against cross-Tauri-app dev-port hijack.
//
// In dev mode, Claudette's webview loads its bundle from a Vite server
// on a localhost port. If another Tauri app's launcher kills or rebinds
// that port (some templates do exactly this with `lsof -ti:1420 | xargs
// kill`), the next HMR reload will serve the FOREIGN bundle into
// Claudette's existing webview window. Without a guard, the user sees
// another app's UI inside Claudette's title bar — confusing and
// dangerous (the foreign app could read state via DOM access etc).
//
// This guard runs synchronously at boot, before React mounts, and
// verifies the served `index.html` carries Claudette's identity marker
// (the `<meta name="x-tauri-app-id" content="com.claudette.app">` in
// our index.html). If the marker is missing or the wrong value, we
// abort the React mount and render a hard-coded HTML error so the user
// can see exactly what happened.
//
// In a release build (frontendDist via Tauri's tauri:// custom protocol)
// the bundle is loaded straight from the binary's resources, so this
// check is a no-op there — but keeping it always-on is cheap and adds
// defense-in-depth even against a hypothetical malicious replacement.

const EXPECTED_APP_ID = "com.claudette.app";

export function bootIdentityGuard(): boolean {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="x-tauri-app-id"]',
  );
  if (meta?.content === EXPECTED_APP_ID) return true;

  // Marker is missing or wrong — render a hard error inline. We don't
  // import any styling utilities here (those would have a dependency on
  // the foreign bundle's modules in the worst case); plain inline styles
  // are the safest option and read clearly even on a half-loaded page.
  const root = document.getElementById("root");
  const observed = meta?.content ?? "(missing)";
  const html = `
    <div style="
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: #1c1815; color: #e07850;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 32px; text-align: center; z-index: 999999;
    ">
      <div style="max-width: 560px;">
        <h1 style="margin: 0 0 16px; color: #f5a0b8;">Foreign content detected</h1>
        <p style="margin: 0 0 12px; line-height: 1.5; color: #e6dccf;">
          Claudette's dev webview is serving content from another app.
          Expected app id <code style="font-family: 'JetBrains Mono', monospace;">${EXPECTED_APP_ID}</code>,
          observed <code style="font-family: 'JetBrains Mono', monospace;">${escapeHtml(observed)}</code>.
        </p>
        <p style="margin: 0 0 16px; line-height: 1.5; color: #e6dccf;">
          A Tauri app on this machine probably grabbed the dev port that
          Claudette's webview was pointed at. Quit any other Tauri dev
          builds, then restart Claudette via <code>scripts/dev.sh</code>.
        </p>
        <p style="margin: 0; font-size: 12px; color: #c4b5fd;">
          You're seeing this instead of a silent UI swap because of
          <code>bootIdentityGuard</code> in <code>src/ui/src/utils/bootIdentityGuard.ts</code>.
        </p>
      </div>
    </div>
  `;
  if (root) {
    root.innerHTML = html;
  } else {
    document.body.innerHTML = html;
  }
  // Print a clear diagnostic for anyone who hits this and opens devtools.
  console.error(
    "[bootIdentityGuard] Expected x-tauri-app-id meta to be %o, got %o. " +
      "Refusing to mount the Claudette React tree — see the rendered notice.",
    EXPECTED_APP_ID,
    observed,
  );
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
