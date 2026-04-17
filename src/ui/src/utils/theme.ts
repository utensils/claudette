import type { ITheme } from "@xterm/xterm";
import type { ThemeDefinition } from "../types/theme";
import { normalizeTheme } from "../types/theme";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "../styles/themes";
import { listUserThemes } from "../services/tauri";

// Vite ?url imports — resolved to asset URLs without injecting CSS
import hljsDarkUrl from "highlight.js/styles/github-dark.min.css?url";
import hljsLightUrl from "highlight.js/styles/github.min.css?url";

export const DEFAULT_SANS_STACK =
  '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const DEFAULT_MONO_STACK =
  '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace';

/**
 * Tokens a theme is *allowed* to set. This is the single source of truth
 * listing every CSS variable the runtime will pick up from a theme file.
 * Any token not in this list is silently ignored when applying a theme —
 * this protects against user themes setting arbitrary CSS custom
 * properties that have nothing to do with Claudette's design system
 * (and against typos cluttering `:root`).
 *
 * To expose a new theme-controllable value:
 *   1. Add its `--var` default to `styles/theme.css` :root
 *   2. Add the token name here
 *   3. Document it in `docs/theming.md`
 */
const THEMEABLE_TOKENS = new Set<string>([
  // Color scheme
  "color-scheme",

  // Surfaces
  "app-bg",
  "sidebar-bg",
  "sidebar-border",
  "panel-bg",
  "surface-bg",
  "sunken-bg",

  // Text
  "text-primary",
  "text-muted",
  "text-dim",
  "text-faint",
  "text-separator",

  // Accent
  "accent-primary",
  "accent-primary-rgb",
  "accent-dim",
  "accent-bg",
  "accent-bg-strong",
  "accent-glow",

  // Interactive
  "hover-bg",
  "hover-bg-subtle",
  "selected-bg",
  "divider",
  "selection-bg",

  // Status
  "status-running",
  "status-idle",
  "status-stopped",

  // Attention badges
  "badge-done",
  "badge-plan",
  "badge-ask",

  // Diff
  "diff-added-bg",
  "diff-removed-bg",
  "diff-added-text",
  "diff-removed-text",
  "diff-hunk-header",
  "diff-line-number",

  // Chat
  "chat-user-bg",
  "chat-system-bg",
  "chat-input-bg",
  "chat-header-bg",

  // Terminal
  "terminal-tab-bg",
  "terminal-tab-active-bg",
  "terminal-bg",
  "terminal-fg",
  "terminal-cursor",
  "terminal-selection",

  // Toolbar
  "toolbar-active",
  "toolbar-active-text",

  // Error
  "error-bg",
  "error-border",
  "error-hover",

  // Overlay
  "overlay-bg",
  "overlay-bg-heavy",

  // Atmosphere / rim lights (Atelier chrome)
  "canvas-atmosphere",
  "rim-light",
  "rim-light-strong",

  // Elevation
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "shadow-card-hover",
  "well-shadow",
  "composer-ring",
  "composer-ring-focus",

  // Typography scale (note: font *families* are intentionally NOT themable —
  // they come from the app's `--font-sans` / `--font-mono` / `--font-display`
  // defaults and from the user's Appearance settings. Themes should adhere
  // to the app's typographic voice; if a theme file declares one of those
  // tokens it's silently ignored with a console warning.)
  "font-size-sm",
  "font-size-base",
  "font-size-md",
  "font-size-lg",
  "font-weight-regular",
  "font-weight-medium",
  "font-weight-semibold",
  "font-weight-bold",
  "line-height-tight",
  "line-height-normal",
  "line-height-relaxed",
  "letter-spacing-tight",
  "letter-spacing-wide",

  // Radius
  "radius-sm",
  "radius-md",
  "radius-lg",
  "radius-pill",
  "border-radius",

  // Spacing
  "space-xs",
  "space-sm",
  "space-md",
  "space-lg",
  "space-xl",

  // Motion
  "transition-fast",
  "transition-normal",
  "transition-slow",
  "ease-standard",
  "ease-accelerate",
  "ease-decelerate",

  // Layout
  // Note: sidebar-width is intentionally NOT themable — it's user
  // preference state (persisted per user, not per theme). AppLayout
  // writes --sidebar-w inline from Zustand on every render, which
  // would clobber any theme value.
  "scrollbar-width",
  "scrollbar-thumb-bg",
  "scrollbar-thumb-hover-bg",
  "focus-ring",
]);

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
  // Escape quotes in font names to produce valid CSS.
  const esc = (s: string) => s.replace(/"/g, '\\"');
  if (fontSans) {
    root.style.setProperty("--font-sans", `"${esc(fontSans)}", ${DEFAULT_SANS_STACK}`);
  }
  if (fontMono) {
    root.style.setProperty("--font-mono", `"${esc(fontMono)}", ${DEFAULT_MONO_STACK}`);
  }
  // Use CSS zoom to scale the entire UI proportionally. All component
  // styles use fixed px values, so changing root font-size alone wouldn't
  // cascade. CSS zoom scales everything — text, spacing, borders —
  // just like browser zoom. Base size is 13px, so zoom = size/13.
  const zoomLevel = uiFontSize / 13;
  root.style.setProperty("zoom", String(zoomLevel));
}

/**
 * Clear user font override, reverting to whatever the theme (or CSS default) set.
 * Call when the user explicitly selects "Default" in settings.
 */
export function clearUserFont(varName: "font-sans" | "font-mono"): void {
  const root = document.documentElement;
  // Remove the inline override. Then re-apply the current theme's value if it
  // has one, so the theme font survives. If the theme doesn't define this var,
  // removeProperty lets the CSS :root default take over.
  root.style.removeProperty(`--${varName}`);
}

export function getTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--terminal-bg").trim() || "#121216",
    foreground: style.getPropertyValue("--terminal-fg").trim() || "#e6e6eb",
    cursor: style.getPropertyValue("--terminal-cursor").trim() || "#e6e6eb",
    selectionBackground:
      style.getPropertyValue("--terminal-selection").trim() || undefined,
  };
}

export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const { tokens, scheme } = normalizeTheme(theme);

  // Clear every themeable variable first so removing a token in a
  // reloaded theme file actually takes effect. Any token NOT in the
  // theme falls back to :root defaults in styles/theme.css.
  for (const name of THEMEABLE_TOKENS) {
    root.style.removeProperty(`--${name}`);
  }

  // Apply every known token the theme declares. Unknown tokens are
  // silently ignored (see THEMEABLE_TOKENS rationale).
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (THEMEABLE_TOKENS.has(name)) {
      root.style.setProperty(`--${name}`, value);
    } else {
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    console.warn(
      `[theme] Ignoring unknown tokens: ${unknown.join(", ")}. ` +
        "Add them to THEMEABLE_TOKENS in utils/theme.ts if intentional.",
    );
  }

  // Set the real color-scheme property so native controls match.
  root.style.setProperty("color-scheme", scheme);

  // Swap highlight.js syntax theme to match light/dark.
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

export async function loadAllThemes(): Promise<ThemeDefinition[]> {
  let userThemes: ThemeDefinition[] = [];
  try {
    userThemes = await listUserThemes();
  } catch (e) {
    console.error("Failed to load user themes:", e);
  }
  const themesById = new Map<string, ThemeDefinition>();
  for (const theme of BUILTIN_THEMES) {
    themesById.set(normalizeTheme(theme).id, theme);
  }
  for (const theme of userThemes) {
    themesById.set(normalizeTheme(theme).id, theme);
  }
  return Array.from(themesById.values());
}

export function findTheme(
  themes: ThemeDefinition[],
  id: string,
): ThemeDefinition {
  const requested = themes.find((t) => normalizeTheme(t).id === id);
  if (requested) return requested;

  const fallback = themes.find(
    (t) => normalizeTheme(t).id === DEFAULT_THEME_ID,
  );
  if (fallback) return fallback;

  if (themes[0]) return themes[0];

  throw new Error("No themes are available.");
}
