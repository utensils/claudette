import type { ITheme } from "@xterm/xterm";
import type { ThemeDefinition } from "../types/theme";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_META,
  DEFAULT_THEME_ID,
} from "../styles/themes";
import { listUserThemes } from "../services/tauri";

// Vite ?url imports — resolved to asset URLs without injecting CSS
import hljsDarkUrl from "highlight.js/styles/github-dark.min.css?url";
import hljsLightUrl from "highlight.js/styles/github.min.css?url";

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

export const DEFAULT_SANS_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const DEFAULT_MONO_STACK =
  '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace';

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

function updateHljsStylesheet(scheme: string): void {
  const isLight = scheme === "light";
  let link = document.getElementById("hljs-theme") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "hljs-theme";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = isLight ? hljsLightUrl : hljsDarkUrl;
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
    const meta = BUILTIN_THEME_META.find((m) => m.id === theme.id);
    updateHljsStylesheet(meta?.colorScheme ?? "dark");
  } else {
    // User-provided JSON theme. Mark data-theme so any default-dark rules
    // still apply as a baseline; inline vars override.
    dataThemeAttr = DEFAULT_THEME_ID;
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
    updateHljsStylesheet(scheme);
  }

  cacheDataTheme(dataThemeAttr);
}

/**
 * Returns the data-theme attribute value that applyTheme() would set for a given theme.
 * Built-in themes use their own ID; user JSON themes layer on top of DEFAULT_THEME_ID.
 */
export function getThemeDataAttr(theme: ThemeDefinition): string {
  return BUILTIN_THEME_IDS.has(theme.id) ? theme.id : DEFAULT_THEME_ID;
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
    themesById.set(theme.id, theme);
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
