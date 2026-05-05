import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from the test file's own URL — `__dirname` is undefined in ESM
// (`"type": "module"` in package.json), and while vitest happens to shim
// it today, deriving from `import.meta.url` keeps this test portable
// against future tooling changes (Copilot review).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Regression test for the layout's two-row top alignment.
//
// The layout has two horizontal alignment rows that must stay in sync:
//   Row 1 (workspace-header height): WorkspacePanelHeader on the chat
//          side, PrStatusBanner on the right side.
//   Row 2 (tab-bar height): SessionTabs (chat tabs) on the chat side,
//          and the RightSidebar tab bar — only when a PR banner is above
//          it (otherwise the right tab bar takes Row 1's role).
//
// Both rows are pinned to CSS variables so a future refactor in any one
// stylesheet doesn't silently desync the columns. This test reads the
// raw module CSS and asserts the referencing min-heights are present —
// a tiny smoke check, not a layout-engine test, but enough to fail CI
// if someone deletes one of these lines without thinking through the
// alignment consequences. See also the live debug-eval verification in
// the PR description for actual rendered alignment.

function readCss(relPath: string): string {
  // From src/ui/src/components/layout/, walk up to src/ui/src/.
  const root = resolve(__dirname, "..", "..");
  return readFileSync(resolve(root, relPath), "utf8");
}

describe("layout header alignment", () => {
  it("defines --workspace-header-h and --tab-bar-h tokens in theme.css", () => {
    const theme = readCss("styles/theme.css");
    expect(theme).toMatch(/--workspace-header-h\s*:\s*\d+px/);
    expect(theme).toMatch(/--tab-bar-h\s*:\s*\d+px/);
  });

  it("WorkspacePanelHeader pins to --workspace-header-h", () => {
    const css = readCss("components/shared/WorkspacePanelHeader.module.css");
    expect(css).toMatch(/min-height:\s*var\(--workspace-header-h\)/);
  });

  it("PrStatusBanner pins to --workspace-header-h (matches Row 1)", () => {
    const css = readCss("components/right-sidebar/PrStatusBanner.module.css");
    expect(css).toMatch(/min-height:\s*var\(--workspace-header-h\)/);
    // The legacy fixed `height: 47px` would defeat the min-height; keep
    // the PR banner free to grow to match the chat header.
    expect(css).not.toMatch(/^\s*height:\s*47px/m);
  });

  it("RightSidebar tab bar pins to --workspace-header-h by default", () => {
    const css = readCss("components/right-sidebar/RightSidebar.module.css");
    expect(css).toMatch(/min-height:\s*var\(--workspace-header-h\)/);
  });

  it("RightSidebar tab bar drops to --tab-bar-h when not first child (PR banner above)", () => {
    const css = readCss("components/right-sidebar/RightSidebar.module.css");
    // Adjacent-sibling override: when PrStatusBanner renders, the tab bar
    // becomes the second child and must shrink to Row 2's height so its
    // bottom border lines up with SessionTabs's bottom border.
    expect(css).toMatch(
      /:not\(:first-child\)[^{]*\{[^}]*min-height:\s*var\(--tab-bar-h\)/s,
    );
  });

  it("SessionTabs (chat tab strip) pins to --tab-bar-h (Row 2)", () => {
    const css = readCss("components/chat/SessionTabs.module.css");
    expect(css).toMatch(/min-height:\s*var\(--tab-bar-h\)/);
  });
});
