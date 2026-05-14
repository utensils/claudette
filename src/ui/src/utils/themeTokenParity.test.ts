// Token-parity validator: catches drift between the runtime-side
// THEMEABLE_VARS allowlist (utils/theme.ts) and the design-token source of
// truth (styles/theme.css). When the two go out of sync:
//
//  - A token defined in theme.css but missing from THEMEABLE_VARS cannot be
//    overridden by a user JSON theme (the apply path skips it).
//  - A token listed in THEMEABLE_VARS but missing from theme.css produces a
//    broken `var()` reference if any component reads it.
//
// We also assert that every per-theme [data-theme] block uses only token
// names that also exist in :root — catching future themes that introduce
// new tokens without registering them, which the original PR feedback
// (@codefriar) called out as a long-term maintenance risk.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const THEME_CSS_PATH = join(__dirname, "../styles/theme.css");

function readThemeCss(): string {
  return readFileSync(THEME_CSS_PATH, "utf8");
}

// Extract a single CSS rule body by selector. Brace-aware so nested
// function-call commas (alpha layers, gradients) don't break the parse.
function ruleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) throw new Error(`selector ${selector} not found in theme.css`);
  // Find the opening brace after the selector.
  const open = css.indexOf("{", idx);
  if (open === -1) throw new Error(`no opening brace for ${selector}`);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    if (depth === 0) return css.slice(open + 1, i);
    i++;
  }
  throw new Error(`unbalanced braces for ${selector}`);
}

// Collect every `--token-name:` declaration in a rule body. Captures the
// name without the leading `--`.
function collectDeclarations(body: string): Set<string> {
  const decls = new Set<string>();
  const re = /--([a-z][a-z0-9-]*)\s*:/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    decls.add(m[1]);
  }
  return decls;
}

// Tokens defined in :root but intentionally NOT exposed via THEMEABLE_VARS
// (i.e., not user-overridable). Most are non-color foundations: spacing,
// sizing, radii, motion. Plus a few internal-only color compositions.
const NON_THEMEABLE_ROOT_TOKENS = new Set<string>([
  // Geometry & motion
  "scrollbar-size", "scrollbar-edge-inset", "scrollbar-thumb", "scrollbar-thumb-hover",
  "workspace-header-h", "tab-bar-h",
  "space-1", "space-2", "space-3", "space-4", "space-5", "space-6", "space-8", "space-10", "space-12", "space-16",
  "transition-fast", "transition-normal", "transition-slow", "ease-out-quick",
  "sidebar-width",
  "radius-xs", "radius-sm", "radius-md", "radius-lg", "radius-xl", "radius-pill", "border-radius",
  // Typography ramp (sizes/weights/lines and composite role tokens)
  "fs-xs", "fs-sm", "fs-base", "fs-md", "fs-lg", "fs-xl", "fs-2xl", "fs-3xl", "fs-4xl",
  "lh-tight", "lh-snug", "lh-body", "lh-loose",
  "fw-regular", "fw-medium", "fw-semibold", "fw-bold",
  "h1-size", "h1-weight", "h1-line",
  "h2-size", "h2-weight", "h2-line",
  "h3-size", "h3-weight", "h3-line",
  "h4-size", "h4-weight", "h4-line",
  "body-size", "body-weight", "body-line",
  "caption-size", "caption-weight", "caption-line",
  "code-size", "code-weight", "code-line",
  // Internal brand-invariant palettes (consumed by components, not user-themeable).
  // Themes can still tune these if they need to via CSS — but we don't
  // promise they're user-JSON-overridable.
  "purple-bg", "purple-bg-hover", "purple-border", "purple-border-hover",
  "purple-btn-bg", "purple-btn-bg-hover", "purple-text",
  "tool-read", "tool-write", "tool-edit", "tool-bash", "tool-web", "tool-agent", "tool-task",
  "ultrathink-red", "ultrathink-orange", "ultrathink-yellow", "ultrathink-green",
  "ultrathink-blue", "ultrathink-indigo", "ultrathink-violet",
  "ultrathink-red-shimmer", "ultrathink-orange-shimmer", "ultrathink-yellow-shimmer",
  "ultrathink-green-shimmer", "ultrathink-blue-shimmer", "ultrathink-indigo-shimmer",
  "ultrathink-violet-shimmer",
  // Derived composites — defined in :root via var(), no per-theme override expected.
  "context-meter-normal", "context-meter-warn", "context-meter-near-full", "context-meter-critical",
  "metric-negative", "metric-negative-soft",
  // git-gutter-modified is set per-theme but not exposed via the user JSON allowlist yet.
  "git-gutter-modified",
]);

// THEMEABLE_VARS entries that are valid CSS but not literal `--token` keys
// in :root (they're well-known CSS properties applied directly).
const NON_TOKEN_THEMEABLE_VARS = new Set<string>([
  "color-scheme",
]);

describe("theme token parity", () => {
  it(":root in theme.css and THEMEABLE_VARS stay in sync", async () => {
    const css = readThemeCss();
    const rootTokens = collectDeclarations(ruleBody(css, ":root"));

    // Import lazily so the test runs even if theme.ts has the side-effect
    // module-level globals from the other test file's stubs in scope.
    const themeModule: unknown = await import("./theme");
    type ThemeModuleWithVars = { __THEMEABLE_VARS?: string[] };
    // THEMEABLE_VARS is module-private, so the validator reads the list via
    // the export below. Add a small accessor in theme.ts if not present.
    const exposed = (themeModule as ThemeModuleWithVars).__THEMEABLE_VARS;
    expect(exposed, "theme.ts must export __THEMEABLE_VARS for the parity test").toBeDefined();
    const themeableVars = new Set(exposed!);

    // 1) Every entry in THEMEABLE_VARS that is a CSS token must exist in :root.
    const missingFromRoot: string[] = [];
    for (const name of themeableVars) {
      if (NON_TOKEN_THEMEABLE_VARS.has(name)) continue;
      if (!rootTokens.has(name)) missingFromRoot.push(name);
    }
    expect(missingFromRoot, "THEMEABLE_VARS entries with no matching --token in :root").toEqual([]);

    // 2) Every token in :root that's a "color-ish" themeable token must be
    //    in THEMEABLE_VARS — unless explicitly listed as non-themeable.
    const missingFromAllowlist: string[] = [];
    for (const name of rootTokens) {
      if (NON_THEMEABLE_ROOT_TOKENS.has(name)) continue;
      if (themeableVars.has(name)) continue;
      missingFromAllowlist.push(name);
    }
    expect(missingFromAllowlist, "tokens in :root missing from THEMEABLE_VARS").toEqual([]);
  });

  it("every [data-theme] block uses only tokens that also exist in :root", () => {
    const css = readThemeCss();
    const rootTokens = collectDeclarations(ruleBody(css, ":root"));

    // Find all [data-theme="..."] selectors.
    const themeBlockRe = /\[data-theme="([a-z0-9-]+)"\]\s*\{/g;
    const themeIds: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = themeBlockRe.exec(css)) !== null) {
      themeIds.push(m[1]);
    }
    expect(themeIds.length).toBeGreaterThan(0);

    const offenders: { theme: string; token: string }[] = [];
    for (const themeId of themeIds) {
      const body = ruleBody(css, `[data-theme="${themeId}"]`);
      const decls = collectDeclarations(body);
      for (const token of decls) {
        if (!rootTokens.has(token)) {
          offenders.push({ theme: themeId, token });
        }
      }
    }
    expect(
      offenders,
      "per-theme blocks must not introduce tokens that aren't declared in :root first",
    ).toEqual([]);
  });
});
