#!/usr/bin/env node
// Enforce the design-system rule: component CSS, JSX/TSX, and application
// TS/JS must reference tokens (`var(--*)`), never raw hex or rgb/rgba
// literals. The canonical token definitions live in src/styles/theme.css —
// that file is the only allowed source of raw color values.
//
// Allowed exceptions outside theme.css:
//   * `rgba(var(--*-rgb), <alpha>)` — the canonical pattern for layering
//     alpha over a token's RGB triplet.
//   * `&#NNNN;` HTML numeric entities in JSX/TSX (e.g. `&#9654;` ▶).
//   * `getPropertyValue("...").trim() || "#..."` — safety fallbacks in
//     `utils/theme.ts` for the rare case a token is missing from the
//     computed style (e.g. before the stylesheet loads). The fallback
//     must match a token that already exists in theme.css.
//   * `accentPreview: "#..."` — mirror of a theme's `--accent-primary`
//     hex in `styles/themes/index.ts`, consumed by CommandPalette to
//     render theme swatches without a runtime style lookup. Each entry
//     must match the hex in the corresponding `[data-theme]` block.
//   * `accent_preview: "#..."` — same as above but in snake_case (the
//     wire format used by the community-registry parsers in tests).
//   * `src/utils/bootIdentityGuard.ts` — cross-app dev-port hijack guard
//     that runs BEFORE React mounts (and BEFORE theme tokens are guaranteed
//     to resolve, especially in the foreign-bundle case it's catching).
//     Theme tokens cannot be the source of truth for an error overlay
//     designed to render even when the surrounding app's CSS hasn't loaded.
//   * `src/utils/theme.test.ts` — vitest cases that assert Base16 → Claudette
//     token conversion produces specific hex values. The hex literals are
//     fixtures and expected outputs, not styling.
//
// Runs from src/ui. Exits non-zero with a report when violations are found.
//
// Ported from the original `check-css-tokens.sh` so the lint runs identically
// on Windows (where `bash` may resolve to WSL bash which can't see the
// Windows-side `node` binary) without depending on a POSIX shell.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "..");

const SCAN_ROOT = resolve(uiRoot, "src");
const EXTENSIONS = [".module.css", ".tsx", ".ts"];
const EXCLUDE_DIR_NAMES = new Set(["node_modules"]);

// --- Regexes mirroring the bash version ---

// Rule 1: hex literal — `#` followed by 3, 4, 6, or 8 hex chars, word boundary.
const HEX_RE = /#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

// Rule 2: any `rgb(` or `rgba(` opening.
const RGBA_OPEN_RE = /rgba?\(/;
// Allowed token-plus-alpha pattern: `rgba(var(--*-rgb), …)`.
const RGBA_TOKEN_RE = /rgba?\(\s*var\(--[a-z0-9-]+-rgb\)/;

// Hex exclusions:
const HEX_EXCLUSIONS = [
  // `&#1234;` HTML numeric entity — decimal codepoint, not a hex color.
  /&#[0-9]+;/,
  // `getPropertyValue("...").trim() || "#..."`
  /getPropertyValue\(.*\)\.trim\(\) \|\| "#/,
  // `getPropertyValue("...").trim() || (... ? "#..." : ...)` ternary fallback.
  /getPropertyValue\(.*\)\.trim\(\)\s*\|\| \(.*\?.*"#/,
  // `accentPreview: "#..."` / `accent_preview: "#..."`
  /(accentPreview|accent_preview):\s*"#/,
];

// Hex file-level exclusions (entire file is exempt from Rule 1).
const HEX_EXCLUDED_FILES = new Set([
  // Path is relative to uiRoot, with forward slashes.
  "src/utils/bootIdentityGuard.ts",
  // Base16 conversion tests need hex fixtures and expected output values.
  "src/utils/theme.test.ts",
]);

// Rgba file-level exclusions (entire file is exempt from Rule 2).
const RGBA_EXCLUDED_FILES = new Set([
  // theme.test.ts test names mention the `rgba(var(...), alpha)` pattern
  // abstractly in `it()` descriptions.
  "src/utils/theme.test.ts",
  // theme.ts's base16 converter emits `rgba(${rgb-triplet}, ${alpha})`
  // strings from template literals as it synthesizes the -bg / -border
  // companion tokens for imported palettes. This is the one place in the
  // app where building an rgba string from JS is the right answer — the
  // alternative (calling out to a CSS-token derivation in `theme.css`) is
  // impossible because the input is a per-theme palette only known at
  // runtime. Do not extend this exemption to other files.
  "src/utils/theme.ts",
]);

// --- Walker ---

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      const name = entry.name;
      // Match longest extension first so `.module.css` wins over `.css`.
      const ext = EXTENSIONS.find((e) => name.endsWith(e));
      if (!ext) continue;
      yield join(dir, entry.name);
    }
  }
}

function relPosix(absPath) {
  return relative(uiRoot, absPath).split(sep).join("/");
}

// Match the bash output format `path:lineno:line` so error messages stay
// recognisable across platforms.
function formatHit(rel, lineno, line) {
  return `${rel}:${lineno}:${line}`;
}

// --- Scan ---

let hexHits = [];
let rgbaHits = [];

for (const absPath of walk(SCAN_ROOT)) {
  const rel = relPosix(absPath);
  let source;
  try {
    source = readFileSync(absPath, "utf8");
  } catch (err) {
    console.error(`ERROR: cannot read ${rel}: ${err.message}`);
    process.exit(2);
  }
  const lines = source.split(/\r?\n/);

  const hexFileExcluded = HEX_EXCLUDED_FILES.has(rel);
  const rgbaFileExcluded = RGBA_EXCLUDED_FILES.has(rel);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineno = i + 1;

    // --- Rule 1: hex literals ---
    if (!hexFileExcluded && HEX_RE.test(line)) {
      const allowed = HEX_EXCLUSIONS.some((re) => re.test(line));
      if (!allowed) {
        hexHits.push(formatHit(rel, lineno, line));
      }
    }

    // --- Rule 2: rgb/rgba literals ---
    if (!rgbaFileExcluded && RGBA_OPEN_RE.test(line) && !RGBA_TOKEN_RE.test(line)) {
      rgbaHits.push(formatHit(rel, lineno, line));
    }
  }
}

let violations = 0;

if (hexHits.length > 0) {
  console.error("ERROR: hex color literals found outside theme.css:");
  for (const hit of hexHits) console.error(hit);
  violations++;
}

if (rgbaHits.length > 0) {
  console.error("ERROR: rgb/rgba() literals found outside theme.css:");
  for (const hit of rgbaHits) console.error(hit);
  violations++;
}

if (violations > 0) {
  console.error("");
  console.error(
    "Design-system check failed. Move tokens into src/styles/theme.css",
  );
  console.error(
    "and reference them as var(--token-name) from component styles.",
  );
  process.exit(1);
}

console.log("Design-system token check passed.");
