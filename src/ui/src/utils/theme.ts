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
  "toolbar-active",
  "toolbar-active-text",
  "app-bg",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "shadow-card-hover",
];

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
