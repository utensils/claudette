import type { ITheme } from "@xterm/xterm";
import type { ThemeDefinition } from "../types/theme";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "../styles/themes";
import { listUserThemes } from "../services/tauri";

// Vite ?url imports — resolved to asset URLs without injecting CSS
import hljsDarkUrl from "highlight.js/styles/github-dark.min.css?url";
import hljsLightUrl from "highlight.js/styles/github.min.css?url";

const THEMEABLE_VARS = [
  "color-scheme",
  "accent-primary",
  "accent-primary-rgb",
  "accent-dim",
  "accent-bg",
  "accent-bg-strong",
  "accent-glow",
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
  for (const varName of THEMEABLE_VARS) {
    const value = theme.colors[varName];
    if (value) {
      root.style.setProperty(`--${varName}`, value);
    } else {
      root.style.removeProperty(`--${varName}`);
    }
  }
  // Set the real color-scheme property so native controls match.
  // Default to "dark" if the theme doesn't specify (e.g. older user themes).
  const scheme = theme.colors["color-scheme"] ?? "dark";
  root.style.setProperty("color-scheme", scheme);

  // Swap highlight.js syntax theme to match light/dark
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
    themesById.set(theme.id, theme);
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
