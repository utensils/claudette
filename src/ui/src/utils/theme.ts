import type { ITheme } from "@xterm/xterm";
import type { ThemeDefinition } from "../types/theme";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_META,
  DEFAULT_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from "../styles/themes";
import { DEFAULT_SANS_STACK, DEFAULT_MONO_STACK } from "../styles/fonts";
import { listUserThemes } from "../services/tauri";

// Re-export so existing call sites (tests, components) keep working while
// the canonical definitions live in src/styles/fonts.ts.
export { DEFAULT_SANS_STACK, DEFAULT_MONO_STACK };

// localStorage key used by index.html's pre-hydration script to set
// data-theme before React mounts. Keep in sync with that script.
const THEME_CACHE_KEY = "claudette.theme";

const THEMEABLE_VARS = [
  "color-scheme",
  "accent-primary",
  "accent-primary-rgb",
  "accent-dim",
  "accent-bg",
  "accent-bg-strong",
  "accent-glow",
  "on-accent",
  "mascot-pink",
  "mascot-pink-dim",
  "sidebar-bg",
  "sidebar-border",
  "text-primary",
  "text-muted",
  "text-dim",
  "text-faint",
  "text-separator",
  "hover-bg",
  "hover-bg-subtle",
  "selected-bg",
  "divider",
  "status-running",
  "status-idle",
  "status-stopped",
  "badge-done",
  "badge-plan",
  "badge-ask",
  // Status accents — each family is a 5-token group (color, -rgb, -bg, -border, -fg).
  // The -bg/-border/-fg layers derive from -rgb in :root, so a user theme typically
  // only needs to set the base color + -rgb.
  "accent-success", "accent-success-rgb", "accent-success-bg", "accent-success-border", "accent-success-fg",
  "accent-warning", "accent-warning-rgb", "accent-warning-bg", "accent-warning-border", "accent-warning-fg",
  "accent-error", "accent-error-rgb", "accent-error-bg", "accent-error-border", "accent-error-fg",
  "accent-info", "accent-info-rgb", "accent-info-bg", "accent-info-border", "accent-info-fg",
  // UI-role tokens — neutral plus secondary/tertiary brand accents.
  "accent-neutral",
  "accent-secondary", "accent-secondary-rgb", "accent-secondary-bg", "accent-secondary-border", "accent-secondary-fg",
  "accent-tertiary", "accent-tertiary-rgb", "accent-tertiary-bg", "accent-tertiary-border", "accent-tertiary-fg",
  // Category slots A–H for "item N of a set" UI (workspace tags, plugin types).
  "category-a-bg", "category-a-border", "category-a-fg",
  "category-b-bg", "category-b-border", "category-b-fg",
  "category-c-bg", "category-c-border", "category-c-fg",
  "category-d-bg", "category-d-border", "category-d-fg",
  "category-e-bg", "category-e-border", "category-e-fg",
  "category-f-bg", "category-f-border", "category-f-fg",
  "category-g-bg", "category-g-border", "category-g-fg",
  "category-h-bg", "category-h-border", "category-h-fg",
  // Syntax highlight palette — mirrors base16 base08–base0F roles.
  "syntax-keyword",
  "syntax-string",
  "syntax-number",
  "syntax-comment",
  "syntax-function",
  "syntax-type",
  "syntax-variable",
  "syntax-operator",
  "diff-added-bg",
  "diff-removed-bg",
  "diff-added-text",
  "diff-removed-text",
  "diff-hunk-header",
  "diff-line-number",
  "chat-user-bg",
  "chat-system-bg",
  "chat-input-bg",
  "chat-header-bg",
  "terminal-tab-bg",
  "terminal-tab-active-bg",
  "terminal-bg",
  "terminal-fg",
  "terminal-cursor",
  "terminal-selection",
  "toolbar-active",
  "toolbar-active-text",
  "error-bg",
  "error-border",
  "error-hover",
  "overlay-bg",
  "overlay-bg-heavy",
  "app-bg",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "shadow-card-hover",
  "font-sans",
  "font-mono",
  "font-display",
];

// Read-only re-export for the parity test (utils/themeTokenParity.test.ts).
// Kept as a separate symbol with a `__` prefix so it's obviously not for
// production callers — they should reach for the canonical Claudette tokens
// via CSS, not enumerate them at runtime.
export const __THEMEABLE_VARS: readonly string[] = THEMEABLE_VARS;

/**
 * Apply user font overrides on top of the current theme.
 * Call AFTER applyTheme() so user preferences take priority.
 * Empty strings leave the theme/default value untouched.
 */
export function applyUserFonts(
  fontSans: string,
  fontMono: string,
  uiFontSize: number,
): void {
  const root = document.documentElement;
  const esc = (s: string) => s.replace(/"/g, '\\"');
  if (fontSans) {
    root.style.setProperty("--font-sans", `"${esc(fontSans)}", ${DEFAULT_SANS_STACK}`);
  }
  if (fontMono) {
    root.style.setProperty("--font-mono", `"${esc(fontMono)}", ${DEFAULT_MONO_STACK}`);
  }
  // CSS zoom scales the entire UI proportionally. All component styles use
  // fixed px values, so changing root font-size alone wouldn't cascade.
  // Base size is 13px, so zoom = size/13.
  const zoomLevel = uiFontSize / 13;
  root.style.setProperty("zoom", String(zoomLevel));
}

/**
 * Clear user font override, reverting to whatever the theme (or CSS default) set.
 */
export function clearUserFont(varName: "font-sans" | "font-mono"): void {
  const root = document.documentElement;
  root.style.removeProperty(`--${varName}`);
}

export function getTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--terminal-bg").trim() || "#1c1815",
    foreground: style.getPropertyValue("--terminal-fg").trim() || "#f0ebe5",
    cursor: style.getPropertyValue("--terminal-cursor").trim() || "#e07850",
    selectionBackground:
      style.getPropertyValue("--terminal-selection").trim() || undefined,
  };
}

// Keys the user may have set via applyUserFonts() — preserved across
// theme switches so font/zoom choices don't reset when picking a theme.
const PRESERVED_INLINE_PROPS = new Set(["--font-sans", "--font-mono", "zoom"]);

function clearThemeableInlineVars(): void {
  const root = document.documentElement;
  // Iterate every inline property and strip all `--*` overrides except
  // the font/zoom keys managed by applyUserFonts. This is stricter than
  // the old THEMEABLE_VARS allowlist — a user JSON theme that sets a
  // non-standard custom property (e.g. `--my-custom-token`) will no
  // longer leak into the next theme.
  const toRemove: string[] = [];
  for (let i = 0; i < root.style.length; i++) {
    const prop = root.style.item(i);
    if (PRESERVED_INLINE_PROPS.has(prop)) continue;
    if (prop.startsWith("--")) toRemove.push(prop);
  }
  for (const prop of toRemove) {
    root.style.removeProperty(prop);
  }
  root.style.removeProperty("color-scheme");
}

function cacheDataTheme(attr: string): void {
  // Mirror the data-theme attribute we just wrote so the pre-hydration
  // script in index.html can restore it before React mounts. For user JSON
  // themes this is DEFAULT_THEME_ID (the baseline they layer on top of) —
  // not the user theme id, which has no matching [data-theme] block.
  try {
    localStorage.setItem(THEME_CACHE_KEY, attr);
  } catch {
    // localStorage may be blocked in some sandboxes; the pre-hydration
    // script simply falls back to the default attribute.
  }
}

/**
 * Apply a theme. Built-in themes flip the `data-theme` attribute on <html>
 * and let the stylesheet's [data-theme] blocks drive the variables. User
 * themes (loaded from the backend as JSON) layer on top via inline
 * setProperty calls, which beat stylesheet specificity.
 */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const isBuiltin = BUILTIN_THEME_IDS.has(theme.id);

  let dataThemeAttr: string;
  if (isBuiltin) {
    clearThemeableInlineVars();
    dataThemeAttr = theme.id;
    root.setAttribute("data-theme", dataThemeAttr);
  } else {
    // User-provided JSON theme. Pick the baseline matching the theme's
    // declared color-scheme so a light user theme starts from light defaults
    // (avoids a dark first-paint flash); inline vars override either way.
    dataThemeAttr = baselineAttrForTheme(theme);
    root.setAttribute("data-theme", dataThemeAttr);
    for (const varName of THEMEABLE_VARS) {
      const value = theme.colors[varName];
      if (value) {
        root.style.setProperty(`--${varName}`, value);
      } else {
        root.style.removeProperty(`--${varName}`);
      }
    }
    const scheme = theme.colors["color-scheme"] ?? "dark";
    root.style.setProperty("color-scheme", scheme);
  }

  cacheDataTheme(dataThemeAttr);
}

// User JSON themes layer on top of a built-in baseline. Pick the baseline
// matching the theme's color-scheme so the pre-hydration script lands on
// a stylesheet block that's already light or dark — keeps applyTheme() and
// getThemeDataAttr() consistent.
function baselineAttrForTheme(theme: ThemeDefinition): string {
  return theme.colors["color-scheme"] === "light"
    ? DEFAULT_LIGHT_THEME_ID
    : DEFAULT_THEME_ID;
}

/**
 * Returns the data-theme attribute value that applyTheme() would set for a given theme.
 * Built-in themes use their own ID; user JSON themes use the built-in baseline that
 * matches their declared color-scheme.
 */
export function getThemeDataAttr(theme: ThemeDefinition): string {
  return BUILTIN_THEME_IDS.has(theme.id) ? theme.id : baselineAttrForTheme(theme);
}

/**
 * Cache theme mode settings in localStorage so the pre-hydration script in
 * index.html can pick the right data-theme attribute before React mounts.
 */
export function cacheThemePreference(
  mode: "light" | "dark" | "system",
  darkAttr: string,
  lightAttr: string,
): void {
  try {
    localStorage.setItem("claudette.theme_mode", mode);
    localStorage.setItem("claudette.theme_dark_attr", darkAttr);
    localStorage.setItem("claudette.theme_light_attr", lightAttr);
  } catch {
    // localStorage may be blocked in some sandboxes.
  }
}

// ---- Base16 import support ------------------------------------------------
//
// Claudette accepts user themes in `~/.claudette/themes/*.json` either in
// Claudette's native shape (id/name/colors with bare token names like
// `accent-primary` — applyTheme prepends the `--` when setting the CSS
// property) or as a canonical Base16 scheme (`base00`–`base0F` keys).
// Base16 files are detected and converted into Claudette tokens at load time.

const BASE16_KEY_SUFFIXES = [
  "00", "01", "02", "03", "04", "05", "06", "07",
  "08", "09", "0A", "0B", "0C", "0D", "0E", "0F",
] as const;

type Base16Key =
  | "base00" | "base01" | "base02" | "base03"
  | "base04" | "base05" | "base06" | "base07"
  | "base08" | "base09" | "base0A" | "base0B"
  | "base0C" | "base0D" | "base0E" | "base0F";

// Accept #rrggbb, rrggbb, #rgb, rgb (case-insensitive). Return canonical #rrggbb.
function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(v)) {
    const [r, g, b] = v;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function hexToRgbTriplet(hex: string): string {
  const v = hex.replace(/^#/, "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function hexLuminance(hex: string): number {
  const v = hex.replace(/^#/, "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Look up a base16 slot tolerantly: real-world files in the wild use either
// `base0A` (Tinted Theming spec) or `base0a` (some legacy schemes). Accept
// both by normalizing the suffix's case at lookup time.
function readBase16Slot(
  colors: Record<string, string>,
  suffix: string,
): string | undefined {
  return colors[`base${suffix}`] ?? colors[`base${suffix.toLowerCase()}`];
}

// Token names that, when present in a `colors` map, strongly indicate the file
// is a hand-authored Claudette theme rather than a Base16 scheme. Built from
// THEMEABLE_VARS minus a few keys that could legitimately co-exist with a
// base16 payload (e.g. `variant`, `scheme` aren't tokens).
const CLAUDETTE_TOKEN_SET = new Set(THEMEABLE_VARS);

/**
 * A theme payload is base16 iff its `colors` map contains all 16 baseXX slots
 * with valid hex values (case-insensitive on the hex digit) AND it does not
 * declare ANY recognized Claudette token. The latter check makes hybrid files
 * unambiguous: if a file ships both base16 keys and any THEMEABLE_VARS entry,
 * we treat it as Claudette so the author's explicit mappings aren't silently
 * overwritten by the converter.
 */
export function detectBase16(colors: Record<string, string>): boolean {
  for (const key of Object.keys(colors)) {
    if (CLAUDETTE_TOKEN_SET.has(key)) return false;
  }
  for (const suffix of BASE16_KEY_SUFFIXES) {
    const value = readBase16Slot(colors, suffix);
    if (typeof value !== "string") return false;
    if (normalizeHex(value) === null) return false;
  }
  return true;
}

/**
 * Map a base16 palette onto Claudette tokens following the canonical Tinted
 * Theming role spec: base00=bg, base05=fg, base08=red, base0A=yellow,
 * base0B=green, base0D=blue, base0E=purple, etc.
 *
 * For every status/UI-role accent we emit the full triplet companion set
 * (-rgb, -bg, -border, -fg) so the imported palette doesn't inherit the
 * baseline theme's tints. The bg/border/fg layers use the same alpha
 * levels as :root in theme.css.
 *
 * `color-scheme` is read from a `variant` field if present (some base16
 * files declare `"variant": "light"`); otherwise derived from base00's
 * relative luminance.
 */
export function convertBase16ToClaudette(theme: ThemeDefinition): ThemeDefinition {
  const src = theme.colors;
  const palette: Partial<Record<Base16Key, string>> = {};
  for (const suffix of BASE16_KEY_SUFFIXES) {
    const raw = readBase16Slot(src, suffix);
    const norm = normalizeHex(raw ?? "");
    if (norm === null) {
      // detectBase16 should have caught this; bail out and return the input
      // unchanged so applyTheme treats it as a plain Claudette theme.
      return theme;
    }
    palette[`base${suffix}` as Base16Key] = norm;
  }
  const p = palette as Record<Base16Key, string>;

  const variant = (src["variant"] ?? "").toLowerCase();
  const scheme: "light" | "dark" =
    variant === "light" || variant === "dark"
      ? (variant as "light" | "dark")
      : hexLuminance(p.base00) < 0.5
        ? "dark"
        : "light";

  // Emit the full bg/border/fg triplet for a semantic accent. Alpha levels
  // mirror the :root defaults in theme.css (10% tint, 30% outline).
  const emitTriplet = (
    out: Record<string, string>,
    prefix: string,
    hex: string,
  ) => {
    const rgb = hexToRgbTriplet(hex);
    out[prefix] = hex;
    out[`${prefix}-rgb`] = rgb;
    out[`${prefix}-bg`] = `rgba(${rgb}, 0.10)`;
    out[`${prefix}-border`] = `rgba(${rgb}, 0.30)`;
    out[`${prefix}-fg`] = hex;
  };

  const out: Record<string, string> = {
    "color-scheme": scheme,

    // Surfaces
    "app-bg": p.base00,
    "sidebar-bg": p.base01,
    "sidebar-border": p.base02,
    "chat-input-bg": p.base01,
    "chat-header-bg": p.base01,
    "chat-user-bg": p.base01,
    "terminal-bg": p.base00,
    "terminal-tab-bg": p.base01,
    "terminal-tab-active-bg": p.base02,

    // Text ramp — Claudette's primary→muted→dim→faint hierarchy goes from
    // highest to lowest contrast against the bg. In base16, base05 is the
    // default foreground; base04→base03 are progressively dimmer. base06 is
    // a HIGH-contrast tone (brighter than base05 in dark schemes), so it
    // doesn't fit "muted" — we leave it unmapped here.
    "text-primary": p.base05,
    "text-muted": p.base04,
    "text-dim": p.base03,
    "text-faint": p.base03,
    "text-separator": p.base02,
    "on-accent": p.base07,
    "divider": p.base02,
    "selected-bg": p.base02,

    // Legacy semantic-ish tokens kept in sync with new accents.
    "status-running": p.base0B,
    "status-stopped": p.base08,
    "badge-done": p.base0B,
    "badge-plan": p.base0D,
    "badge-ask": p.base0A,

    "accent-neutral": p.base04,

    // Brand accent uses base0E (purple) per the Tinted Theming convention.
    "accent-primary": p.base0E,
    "accent-primary-rgb": hexToRgbTriplet(p.base0E),
    "accent-dim": p.base0F,

    // Diff
    "diff-added-text": p.base0B,
    "diff-removed-text": p.base08,
    "diff-hunk-header": p.base0D,
    "diff-line-number": p.base03,

    // Syntax — direct base08-base0F mapping per spec.
    "syntax-variable": p.base08,
    "syntax-number": p.base09,
    "syntax-type": p.base0A,
    "syntax-string": p.base0B,
    "syntax-operator": p.base0C,
    "syntax-function": p.base0D,
    "syntax-keyword": p.base0E,
    "syntax-comment": p.base03,
  };

  // Status + UI-role accents — full triplets so imported palettes don't
  // inherit baseline tints.
  emitTriplet(out, "accent-success", p.base0B);
  emitTriplet(out, "accent-warning", p.base09);
  emitTriplet(out, "accent-error", p.base08);
  emitTriplet(out, "accent-info", p.base0D);
  emitTriplet(out, "accent-secondary", p.base0F);
  emitTriplet(out, "accent-tertiary", p.base0E);

  return {
    id: theme.id,
    name: theme.name,
    author: theme.author,
    description: theme.description,
    colors: out,
  };
}

export async function loadAllThemes(): Promise<ThemeDefinition[]> {
  let userThemes: ThemeDefinition[] = [];
  try {
    userThemes = await listUserThemes();
  } catch (e) {
    console.error("Failed to load user themes:", e);
  }
  const themesById = new Map<string, ThemeDefinition>();
  // Built-ins: the full palette lives in CSS, but CommandPalette renders a
  // per-theme accent swatch from theme.colors, so seed the two preview
  // fields from metadata. Everything else resolves via the stylesheet.
  for (const meta of BUILTIN_THEME_META) {
    themesById.set(meta.id, {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      colors: {
        "accent-primary": meta.accentPreview,
        "color-scheme": meta.colorScheme,
      },
    });
  }
  for (const theme of userThemes) {
    const resolved = detectBase16(theme.colors)
      ? convertBase16ToClaudette(theme)
      : theme;
    themesById.set(resolved.id, resolved);
  }
  return Array.from(themesById.values());
}

export function findTheme(
  themes: ThemeDefinition[],
  id: string,
): ThemeDefinition {
  const requested = themes.find((t) => t.id === id);
  if (requested) return requested;

  const fallback = themes.find((t) => t.id === DEFAULT_THEME_ID);
  if (fallback) return fallback;

  if (themes[0]) return themes[0];

  throw new Error("No themes are available.");
}
