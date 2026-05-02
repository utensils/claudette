#!/usr/bin/env node
// Enforce that the Monaco editor's monospace font stack matches the CSS
// `--font-mono` token. Monaco measures glyph widths via `canvas.measureText`,
// which does not resolve CSS custom properties — so the editor is configured
// with a literal stack imported from `src/styles/fonts.ts`. If that literal
// drifts away from `--font-mono` in `styles/theme.css`, cursor and selection
// positioning silently break on machines where the new front-of-stack font
// is installed but the old stack falls back.
//
// This script parses both files, normalizes whitespace, and asserts equality.
// It runs from src/ui as part of `bun run lint:css`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "..");
const fontsTsPath = resolve(uiRoot, "src/styles/fonts.ts");
const themeCssPath = resolve(uiRoot, "src/styles/theme.css");

function normalize(value) {
  // Collapse all runs of whitespace (incl. newlines inside the CSS value)
  // to a single space, then trim. Quotes are preserved so `"JetBrains Mono"`
  // and `'JetBrains Mono'` would still differ — that's intentional, the two
  // sources should agree on punctuation.
  return value.replace(/\s+/g, " ").trim();
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    console.error(`ERROR: cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

function extractTsConstant(source, name) {
  // Match `export const NAME = '...'` or `export const NAME = "..."`,
  // possibly broken across lines. Captures the inner string contents.
  const re = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`,
    "m",
  );
  const m = source.match(re);
  if (!m) return null;
  return m[2];
}

function extractCssVar(source, name) {
  // Match `--name: <value>;`. The value can span multiple lines if
  // the author wraps it, so we use [^;]+.
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const m = source.match(re);
  if (!m) return null;
  return m[1];
}

const fontsTs = readFile(fontsTsPath);
const themeCss = readFile(themeCssPath);

const tsValue = extractTsConstant(fontsTs, "DEFAULT_MONO_STACK");
if (tsValue === null) {
  console.error(
    `ERROR: could not find \`export const DEFAULT_MONO_STACK\` in ${fontsTsPath}`,
  );
  process.exit(2);
}

const cssValue = extractCssVar(themeCss, "font-mono");
if (cssValue === null) {
  console.error(
    `ERROR: could not find \`--font-mono\` declaration in ${themeCssPath}`,
  );
  process.exit(2);
}

const tsNorm = normalize(tsValue);
const cssNorm = normalize(cssValue);

if (tsNorm !== cssNorm) {
  console.error("ERROR: Monaco font stack drift detected.");
  console.error("");
  console.error(`  src/styles/fonts.ts  DEFAULT_MONO_STACK:`);
  console.error(`    ${tsNorm}`);
  console.error(`  src/styles/theme.css --font-mono:`);
  console.error(`    ${cssNorm}`);
  console.error("");
  console.error(
    "These must match exactly (after whitespace normalization) so that",
  );
  console.error(
    "Monaco's canvas-measured glyph widths agree with the rendered DOM font.",
  );
  console.error(
    "Update both `src/styles/fonts.ts` and `src/styles/theme.css` together.",
  );
  process.exit(1);
}

console.log("Monaco font-stack drift check passed.");
