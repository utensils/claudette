// Dev-only theme proof page. Renders every design token as a labeled swatch
// so theme authors can audit their palette end-to-end while porting. Mount
// from the devtools console:
//
//     __CLAUDETTE_THEME_PROOF__()
//
// Close the overlay with Esc or by calling the function again.
//
// Gated behind `import.meta.env.DEV` — excluded from release builds.

import { __THEMEABLE_VARS } from "./theme";

const OVERLAY_ID = "__claudette-theme-proof__";

// Group tokens for visual organization. Each entry is [section title, prefix-match-regex].
// Anything that doesn't match a section appears under "Other".
const SECTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Brand accent", /^(accent-primary|accent-dim|accent-bg|accent-glow|on-accent)/],
  ["Status accents", /^accent-(success|warning|error|info)/],
  ["UI roles", /^accent-(neutral|secondary|tertiary)/],
  ["Category slots A–H", /^category-/],
  ["Syntax highlights", /^syntax-/],
  ["Legacy semantic", /^(badge-|status-|error-)/],
  ["Text ramp", /^text-/],
  ["Surfaces", /^(app-bg|sidebar-|chat-|terminal-)/],
  ["Interactive", /^(hover-|selected-|divider|toolbar-)/],
  ["Diff", /^diff-/],
  ["Shadows", /^shadow-/],
  ["Overlay", /^overlay-/],
  ["Typography", /^font-/],
] as const;

function classify(name: string): string {
  for (const [title, re] of SECTIONS) {
    if (re.test(name)) return title;
  }
  return "Other";
}

function renderSwatch(token: string): HTMLElement {
  const root = getComputedStyle(document.documentElement);
  const value = root.getPropertyValue(`--${token}`).trim();
  const isColorish =
    /^#|^rgb|^rgba|^hsl|^var/.test(value) ||
    /-(bg|border|fg|text|primary|dim|glow|hover|selected|cursor|selection)$/.test(token);

  const row = document.createElement("div");
  row.style.cssText = `
    display: grid;
    grid-template-columns: 80px 1fr 1fr;
    gap: 12px;
    align-items: center;
    padding: 6px 10px;
    border-radius: 6px;
    font: 12px/1.4 ui-monospace, monospace;
  `;

  const swatch = document.createElement("div");
  swatch.style.cssText = `
    width: 72px;
    height: 32px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--divider);
    background: ${isColorish && value ? `var(--${token})` : "transparent"};
  `;
  if (!isColorish) {
    // Diagonal stripe pattern to mark non-color tokens. Built from text-faint
    // so it tracks the active theme.
    swatch.style.background = "repeating-linear-gradient(45deg, transparent, transparent 6px, var(--text-faint) 6px, var(--text-faint) 12px)";
    swatch.style.opacity = "0.35";
    swatch.title = "non-color token";
  }

  const nameEl = document.createElement("code");
  nameEl.textContent = `--${token}`;
  nameEl.style.cssText = "color: var(--text-primary); opacity: 0.95;";

  const valEl = document.createElement("code");
  valEl.textContent = value || "(unset)";
  valEl.style.cssText = "color: var(--text-muted); word-break: break-all;";

  row.append(swatch, nameEl, valEl);
  return row;
}

function renderProof(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: var(--app-bg);
    color: var(--text-primary);
    z-index: 999999;
    overflow: auto;
    padding: 24px 32px;
    font-family: var(--font-sans);
  `;

  const header = document.createElement("header");
  header.style.cssText = "display:flex; justify-content:space-between; align-items:baseline; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--divider);";
  const title = document.createElement("h1");
  title.textContent = "Theme proof — dev only";
  title.style.cssText = "font-size: 20px; margin: 0;";
  const hint = document.createElement("div");
  hint.textContent = "Press Esc or call __CLAUDETTE_THEME_PROOF__() again to close.";
  hint.style.cssText = "font-size: 11px; color: var(--text-muted);";
  header.append(title, hint);
  overlay.append(header);

  // Group tokens by section.
  const groups = new Map<string, string[]>();
  for (const t of __THEMEABLE_VARS) {
    if (t === "color-scheme") continue;
    const section = classify(t);
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(t);
  }

  // Render in SECTIONS order, then "Other" last.
  const order = [...SECTIONS.map(([t]) => t), "Other"];
  for (const section of order) {
    const tokens = groups.get(section);
    if (!tokens || tokens.length === 0) continue;
    const h2 = document.createElement("h2");
    h2.textContent = `${section} (${tokens.length})`;
    h2.style.cssText = "font-size: 14px; margin: 20px 0 8px; color: var(--accent-primary);";
    overlay.append(h2);
    for (const token of tokens.sort()) {
      overlay.append(renderSwatch(token));
    }
  }

  // Append category strip showing all 8 chip-styled slots side by side —
  // the headline use case @codefriar called out (workspace tag chips).
  const stripWrap = document.createElement("section");
  stripWrap.style.cssText = "margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--divider);";
  const stripTitle = document.createElement("h2");
  stripTitle.textContent = "Category slots — rendered as chips";
  stripTitle.style.cssText = "font-size: 14px; margin: 0 0 12px; color: var(--accent-primary);";
  stripWrap.append(stripTitle);
  const strip = document.createElement("div");
  strip.style.cssText = "display:flex; flex-wrap:wrap; gap: 8px;";
  for (const slot of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    const chip = document.createElement("span");
    chip.textContent = `category-${slot}`;
    chip.style.cssText = `
      display: inline-flex; align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font: 11px/1 ui-monospace, monospace;
      background: var(--category-${slot}-bg);
      border: 1px solid var(--category-${slot}-border);
      color: var(--category-${slot}-fg);
    `;
    strip.append(chip);
  }
  stripWrap.append(strip);
  overlay.append(stripWrap);

  return overlay;
}

export function toggleThemeProof(): void {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.remove();
    return;
  }
  const overlay = renderProof();
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);
  document.body.append(overlay);
}

// Expose on window in dev builds. Same pattern as __CLAUDETTE_STORE__.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_THEME_PROOF__ =
    toggleThemeProof;
}
