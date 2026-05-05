import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the production-build dist/index.html.
//
// Vite's HTML transform is regex-based and has historically spliced
// production-mode asset preloads inside any HEAD/BODY/TITLE close-tag
// substring it encounters — including ones inside inline <script>
// string literals or comments. The first variant produces a SyntaxError
// in the inline guard and a release build that boots to a blank window;
// the second variant silently dumps <link rel="modulepreload"> tags
// inside a JS comment, where they're never honored as preloads.
//
// CI's frontend job runs `bun run build` immediately before `bun run
// test`, so dist/ exists when this test runs there. Locally, devs who
// run vitest without first building skip these checks (with a clear
// hint above the assertions).

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_HTML = resolve(__dirname, "../../dist/index.html");

// Match <script>...</script> blocks WITHOUT a `src=` attribute (i.e.
// inline scripts only). The negative-lookahead in the opening tag
// rejects external references so we don't accidentally try to "parse"
// a self-closing-by-empty-content reference like
// <script src="/foo.js"></script>.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  // Use a fresh regex instance per call — RegExp with /g state is
  // notoriously easy to corrupt across describe blocks.
  const re = new RegExp(INLINE_SCRIPT_RE.source, INLINE_SCRIPT_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

describe.skipIf(!existsSync(DIST_HTML))("built dist/index.html", () => {
  const html = readFileSync(DIST_HTML, "utf-8");
  const inlineScripts = extractInlineScripts(html);

  // ---- Strategy A: every inline <script> parses as valid JavaScript ----
  //
  // Catches the original failure mode: Vite spliced asset tags inside a
  // single-quoted string literal in document.write(), breaking the JS
  // across multiple lines and producing a SyntaxError that knocked out
  // the entire boot path.

  it("has at least one inline <script> block (sanity)", () => {
    expect(inlineScripts.length).toBeGreaterThan(0);
  });

  it("every inline <script> body parses as valid JavaScript", () => {
    inlineScripts.forEach((body, i) => {
      // new Function() throws SyntaxError on parse failure; the body is
      // wrapped as a function body so top-level IIFEs / declarations
      // are fine.
      expect(
        () => new Function(body),
        `inline <script> ${i + 1} of ${inlineScripts.length} is not valid JS`,
      ).not.toThrow();
    });
  });

  // ---- Strategy B: marker assertions on the build output ----
  //
  // Catches subtler Vite-mangling that doesn't break parsing — e.g. the
  // case where preloads were spliced inside a JS comment. Still valid
  // JS, but the asset tags now sit inside an inline script instead of
  // being honored as <link>/<script src=> at document level.

  it("preserves the x-tauri-app-id identity meta tag", () => {
    expect(html).toMatch(
      /<meta\s+name="x-tauri-app-id"\s+content="com\.claudette\.app"\s*\/?>/,
    );
  });

  it("never embeds modulepreload or bundle script tags inside inline <script>", () => {
    // The bundle entry and asset preloads must live at document level,
    // not inside any inline script's body, comment, or string literal.
    for (const body of inlineScripts) {
      expect(body).not.toMatch(/<link\s+rel="modulepreload"/);
      expect(body).not.toMatch(/<script\s+type="module"\s+crossorigin\s+src=/);
    }
  });

  it("emits the bundle <script type=\"module\"> tag at document level", () => {
    expect(html).toMatch(
      /<script\s+type="module"\s+crossorigin\s+src="\/assets\/[^"]+\.js"><\/script>/,
    );
  });

  it("keeps the inline hijack guard's IIFE wrapper intact", () => {
    // Find the inline script tagged with our hijack-blocked marker; both
    // its IIFE opener and closer must survive the build pipeline.
    const guard = inlineScripts.find((s) =>
      s.includes("__claudetteHijackBlocked"),
    );
    expect(
      guard,
      "no inline <script> with __claudetteHijackBlocked marker found",
    ).toBeDefined();
    expect(guard).toMatch(/\(function \(\) \{/);
    expect(guard).toMatch(/\}\)\(\);/);
  });
});
