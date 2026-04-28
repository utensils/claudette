// Built-in theme metadata. Palettes live in styles/theme.css as
// `[data-theme="..."]` blocks — this file only carries what the settings
// switcher and command palette need: id, display name, description,
// color-scheme hint, and an accent preview hex for the palette swatch.
//
// `accentPreview` mirrors the `--accent-primary` value of the matching
// [data-theme] block. It is used only for the CommandPalette theme swatch
// preview; the runtime value at paint time comes from the stylesheet.
//
// Order: Default Dark and Default Light are pinned at the top as the
// canonical entry points; the remainder is sorted alphabetically by name.

export interface BuiltinThemeMeta {
  id: string;
  name: string;
  description: string;
  colorScheme: "dark" | "light";
  accentPreview: string;
}

export const BUILTIN_THEME_META: BuiltinThemeMeta[] = [
  {
    id: "default-dark",
    name: "Default Dark",
    description: "Claudette's signature theme — coral on warm charcoal",
    colorScheme: "dark",
    accentPreview: "#e07850",
  },
  {
    id: "default-light",
    name: "Default Light",
    description: "Cream paper with deep coral accents",
    colorScheme: "light",
    accentPreview: "#c45a35",
  },
  {
    id: "brink",
    name: "Brink",
    description: "Mid-tone warm chrome with Ristretto-style gold accent",
    colorScheme: "dark",
    accentPreview: "#f9cc6c",
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    description: "Maximum legibility with cyan accent",
    colorScheme: "dark",
    accentPreview: "#00ffdd",
  },
  {
    id: "jellybeans",
    name: "Jellybeans",
    description: "Dark Vim-inspired palette with cool slate accent",
    colorScheme: "dark",
    accentPreview: "#8197bf",
  },
  {
    id: "jellybeans-muted",
    name: "Jellybeans Muted",
    description: "Softer, desaturated take on Jellybeans",
    colorScheme: "dark",
    accentPreview: "#7088a8",
  },
  {
    id: "midnight-blue",
    name: "Midnight Blue",
    description: "Cool blue-tinted dark theme",
    colorScheme: "dark",
    accentPreview: "#4a9eff",
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    description: "Soho-vibes dark with iris accent",
    colorScheme: "dark",
    accentPreview: "#c4a7e7",
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    description: "Rosé Pine light — cream parchment with iris accent",
    colorScheme: "light",
    accentPreview: "#907aa9",
  },
  {
    id: "rose-pine-moon",
    name: "Rosé Pine Moon",
    description: "Rosé Pine on warmer navy base",
    colorScheme: "dark",
    accentPreview: "#c4a7e7",
  },
  {
    id: "sidekick",
    name: "Sidekick",
    description: "Ship Sidekick brand — deep navy with electric violet",
    colorScheme: "dark",
    accentPreview: "#8a92ff",
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Schoonover's canonical dark with blue accent",
    colorScheme: "dark",
    accentPreview: "#268bd2",
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "Solarized inverted monotones with identical accents",
    colorScheme: "light",
    accentPreview: "#268bd2",
  },
  {
    id: "warm-ember",
    name: "Warm Ember",
    description: "Warm amber-toned dark theme",
    colorScheme: "dark",
    accentPreview: "#f0a050",
  },
];

export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(
  BUILTIN_THEME_META.map((t) => t.id),
);

export const DEFAULT_THEME_ID = "default-dark";
export const DEFAULT_LIGHT_THEME_ID = "default-light";
