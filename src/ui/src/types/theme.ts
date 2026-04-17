/**
 * Theme definition format.
 *
 * Two shapes are accepted by the runtime (see utils/theme.ts):
 *
 * 1. **Structured** (preferred, future-facing): manifest metadata + grouped
 *    `tokens` object. Authoring is more readable, schema-validatable, and
 *    supports non-color tokens (typography, motion, radius, elevation, etc.).
 *
 * 2. **Flat legacy**: top-level `id` / `name` / `colors` object. Still
 *    accepted so older user themes keep working.
 *
 * At runtime every leaf value becomes a CSS custom property on `:root`
 * (e.g. `accent-primary` → `--accent-primary`). Group names are *not*
 * prefixed onto the variable — they only exist for authoring ergonomics.
 */

/** Metadata block — describes the theme and how to preview it. */
export interface ThemeManifest {
  id: string;
  name: string;
  author?: string;
  description?: string;
  version?: string;
  /**
   * Controls the native `color-scheme` CSS property so browser chrome
   * (form controls, scrollbars on some platforms, focus rings) matches.
   */
  scheme?: "dark" | "light";
  /**
   * Swatches shown in the theme picker preview tile. Optional —
   * the picker can fall back to reading tokens directly.
   */
  preview?: {
    background?: string;
    surface?: string;
    accent?: string;
    text?: string;
  };
}

/**
 * Structured token tree: `tokens.<group>.<token-name> = value`.
 *
 * Group names are purely organizational — the runtime flattens the tree
 * and uses the leaf key as the CSS variable name. Any group name works;
 * recommended groups are `color`, `elevation`, `typography`, `radius`,
 * `spacing`, `motion`, `layout`.
 */
export type ThemeTokens = Record<string, Record<string, string>>;

/** Structured theme shape (preferred). */
export interface StructuredTheme {
  $schema?: string;
  manifest: ThemeManifest;
  tokens: ThemeTokens;
}

/** Legacy flat theme shape (still accepted for back-compat). */
export interface LegacyTheme {
  id: string;
  name: string;
  author?: string;
  description?: string;
  colors: Record<string, string>;
}

export type ThemeDefinition = StructuredTheme | LegacyTheme;

/** Narrowing helper — true when the theme uses the structured shape. */
export function isStructuredTheme(
  theme: ThemeDefinition,
): theme is StructuredTheme {
  return "manifest" in theme && "tokens" in theme;
}

/**
 * Unified accessor — returns `{ id, name, scheme, tokens }` regardless of
 * which shape the theme uses. `tokens` is always a flat map ready to
 * apply as CSS custom properties.
 */
export function normalizeTheme(theme: ThemeDefinition): {
  id: string;
  name: string;
  author?: string;
  description?: string;
  scheme: "dark" | "light";
  tokens: Record<string, string>;
} {
  if (isStructuredTheme(theme)) {
    const flat: Record<string, string> = {};
    for (const group of Object.values(theme.tokens)) {
      for (const [key, value] of Object.entries(group)) {
        flat[key] = value;
      }
    }
    return {
      id: theme.manifest.id,
      name: theme.manifest.name,
      author: theme.manifest.author,
      description: theme.manifest.description,
      scheme: theme.manifest.scheme ?? detectScheme(flat),
      tokens: flat,
    };
  }
  return {
    id: theme.id,
    name: theme.name,
    author: theme.author,
    description: theme.description,
    scheme: detectScheme(theme.colors),
    tokens: backfillLegacyShellTokens(theme.colors),
  };
}

/**
 * Legacy flat themes predate the substrate-layer system (`panel-bg`,
 * `surface-bg`, `sunken-bg`). Without these, the refactored app shell
 * would render old themes with a mismatched palette — the sidebar and
 * canvas would fall back to the built-in defaults instead of the
 * theme's colors. Synthesize reasonable aliases from the legacy tokens
 * the old theme *does* define so the overall palette stays coherent.
 *
 * Priority order per target:
 *   panel-bg   ← sidebar-bg ← app-bg
 *   surface-bg ← app-bg adjusted slightly lighter (we just reuse app-bg)
 *   sunken-bg  ← chat-input-bg ← app-bg
 */
function backfillLegacyShellTokens(
  colors: Record<string, string>,
): Record<string, string> {
  const out = { ...colors };
  if (!("panel-bg" in out)) {
    const fallback = out["sidebar-bg"] ?? out["app-bg"];
    if (fallback) out["panel-bg"] = fallback;
  }
  if (!("surface-bg" in out)) {
    const fallback = out["app-bg"] ?? out["panel-bg"];
    if (fallback) out["surface-bg"] = fallback;
  }
  if (!("sunken-bg" in out)) {
    const fallback = out["chat-input-bg"] ?? out["app-bg"];
    if (fallback) out["sunken-bg"] = fallback;
  }
  return out;
}

function detectScheme(tokens: Record<string, string>): "dark" | "light" {
  const declared = tokens["color-scheme"];
  if (declared === "light" || declared === "dark") return declared;
  return "dark";
}
