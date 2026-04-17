# Theming Claudette

Claudette ships with one built-in theme (`default`) and loads any `*.json` theme file placed in `~/.claudette/themes/` at startup. A theme is a JSON document describing **design tokens** (colors, elevation, typography, radii, motion, layout) — each token maps 1:1 to a CSS custom property on `:root`.

This doc is the authoring reference. The JSON schema at `src/ui/src/styles/themes/theme.schema.json` is the machine-readable version; point your editor at it for autocomplete and inline validation.

---

## Quick start

1. Create `~/.claudette/themes/my-theme.json`.
2. Copy the skeleton below and start replacing values.
3. Restart Claudette (or reload — themes are re-read on app start).
4. Pick your theme in **Settings → Appearance**.

```json
{
  "$schema": "https://claudette.app/schemas/theme.schema.json",
  "manifest": {
    "id": "my-theme",
    "name": "My Theme",
    "author": "you",
    "version": "1.0.0",
    "scheme": "dark",
    "description": "One-line tagline.",
    "preview": {
      "background": "#0e0e12",
      "surface": "#161620",
      "accent": "#00e5cc",
      "text": "#ebebf0"
    }
  },
  "tokens": {
    "color": {
      "color-scheme": "dark",
      "app-bg": "#0e0e12",
      "panel-bg": "#16161d",
      "surface-bg": "#1a1a22",
      "sunken-bg": "#0a0a0e",
      "text-primary": "#ebebf0",
      "accent-primary": "#00e5cc",
      "accent-primary-rgb": "0, 229, 204"
    }
  }
}
```

That's enough to boot. Any token you omit inherits the built-in default from `src/ui/src/styles/theme.css`.

---

## How it works

1. At app start, `utils/theme.ts` loads every JSON theme (built-in + `~/.claudette/themes/`).
2. When you pick a theme, `applyTheme()` walks the `tokens` tree, flattens group/token → `--token` CSS variable, and sets them on `:root`.
3. Group names (`color`, `typography`, …) are **organizational only** — they don't appear in CSS variable names. A `tokens.color.accent-primary` value becomes `--accent-primary`, not `--color-accent-primary`.
4. Tokens *not* in the allowlist (`THEMEABLE_TOKENS` in `utils/theme.ts`) are silently ignored with a console warning. This prevents typos and stray keys from polluting `:root`.
5. A missing token falls back to the `:root` default in `theme.css`.

## Manifest fields

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Unique kebab-case identifier (`my-theme`, `rose-pine-moon`). |
| `name` | yes | Label in the theme picker. |
| `author` | no | Attribution. |
| `version` | no | Semver (`1.0.0`). Theme picker may show on hover. |
| `scheme` | no | `"dark"` or `"light"`. Sets native `color-scheme`, picks a matching syntax-highlight theme for code blocks, and hints the theme picker preview. Defaults to `"dark"`. |
| `description` | no | One-line tagline under the name. |
| `preview` | no | Swatches shown in the theme-picker tile. If omitted, the picker reads tokens directly. |

## Token groups

Every token below is a CSS variable with a built-in default. Override any subset.

### `color` — surfaces, text, semantic colors

#### Substrate layers (depth without borders)

| Token | What it controls |
|---|---|
| `app-bg` | Outermost window background. |
| `panel-bg` | Sidebar, right rail, other flanking panels. |
| `surface-bg` | Raised surfaces (chat canvas). Sits visually *above* the panels. |
| `sunken-bg` | Recessed wells — the composer, code blocks, tool detail. |

**Recipe**: grade dark themes from near-black (`app-bg`) up through subtly lighter shades. Light themes invert.

#### Text

| Token | Typical use |
|---|---|
| `text-primary` | Body text, headings. |
| `text-muted` | Secondary labels. |
| `text-dim` | Captions, timestamps. |
| `text-faint` | Placeholder text, disabled. |
| `text-separator` | Hairline rules and disabled borders. |

#### Accent (the brand wire)

| Token | Use |
|---|---|
| `accent-primary` | The single accent color. Used as a hairline wire, not a fill. |
| `accent-primary-rgb` | RGB triple for `rgba()` — e.g. `"0, 229, 204"`. |
| `accent-dim` | Darker accent for hover/active states. |
| `accent-bg`, `accent-bg-strong` | Low-alpha tints of the accent. |
| `accent-glow` | Optional `box-shadow` used on running indicators. |

#### Interactive

| Token | Use |
|---|---|
| `hover-bg` / `hover-bg-subtle` | Row / button hover backgrounds. |
| `selected-bg` | Selected workspace, highlighted item. |
| `divider` | Very-low-contrast rules (used sparingly — depth is preferred). |
| `selection-bg` | Text `::selection` background. |

#### Status / badges

`status-running` · `status-idle` · `status-stopped` · `badge-done` · `badge-plan` · `badge-ask`

#### Diff

`diff-added-bg` · `diff-removed-bg` · `diff-added-text` · `diff-removed-text` · `diff-hunk-header` · `diff-line-number`

#### Chat, terminal, toolbar, errors, overlays

See `theme.css` for the full list. Every `--var` declared there is overridable.

#### Atmosphere

| Token | Use |
|---|---|
| `canvas-atmosphere` | `background` value applied behind the chat canvas. Use `none` to disable, or replace with your own gradients. |
| `rim-light` / `rim-light-strong` | `inset 0 1px 0 …` top-edge highlights on raised surfaces. |

### `elevation` — shadow language

| Token | Use |
|---|---|
| `shadow-sm` / `shadow-md` / `shadow-lg` | Ambient elevation scale. |
| `shadow-card-hover` | Hover state for workspace tiles, cards. |
| `well-shadow` | Inset shadow for sunken surfaces (composer). |
| `composer-ring` | `box-shadow` on the chat composer at rest. |
| `composer-ring-focus` | `box-shadow` on the chat composer when focused. |

**Tip**: pick one directional light (e.g. top-right) and keep every shadow consistent. Don't mix `rgba(0,0,0,…)` with `rgba(accent,…)` randomly — pick *one* shadow tint per theme.

### `typography`

| Token | Default | Notes |
|---|---|---|
| `font-sans` | Instrument Sans | UI body. |
| `font-mono` | JetBrains Mono | Code, branches, terminal UI bits. |
| `font-display` | Instrument Serif | Optional editorial accent (the italic "Workspaces" eyebrow). |
| `font-size-sm` / `-base` / `-md` / `-lg` | 11 / 13 / 14 / 16 px | Use these instead of raw `px` in component CSS. |
| `font-weight-regular` / `-medium` / `-semibold` / `-bold` | 400 / 500 / 600 / 700 | |
| `line-height-tight` / `-normal` / `-relaxed` | 1.3 / 1.55 / 1.7 | |
| `letter-spacing-tight` / `-wide` | -0.01em / 0.05em | |

### `radius`

| Token | Default | Use |
|---|---|---|
| `radius-sm` | 4px | Small chips, scrollbar thumb. |
| `radius-md` | 8px | Buttons, badges, cards. |
| `radius-lg` | 14px | Major panels, the composer slab. |
| `radius-pill` | 999px | Full-pill buttons, capsule badges. |
| `border-radius` | alias for `radius-md` | Legacy catch-all; prefer the scale. |

### `spacing`

`space-xs` · `space-sm` · `space-md` · `space-lg` · `space-xl` (default 4 / 8 / 12 / 16 / 24 px). Primarily consumed by component CSS — overriding here rescales the UI density globally.

### `motion`

| Token | Default |
|---|---|
| `transition-fast` | `0.12s ease` |
| `transition-normal` | `0.2s ease` |
| `transition-slow` | `0.3s ease` |
| `ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `ease-accelerate` | `cubic-bezier(0.4, 0, 1, 1)` |
| `ease-decelerate` | `cubic-bezier(0, 0, 0.2, 1)` |

### `layout`

| Token | Use |
|---|---|
| `sidebar-width` | Initial sidebar width (user-resizable afterwards). |
| `scrollbar-width` | Scrollbar gutter size. |
| `scrollbar-thumb-bg` / `scrollbar-thumb-hover-bg` | Scrollbar thumb colors. |
| `focus-ring` | `box-shadow` applied to `:focus-visible`. |

---

## Light themes

Light themes need more than inverted colors — shadows that use solid black look muddy on white. Override elevation tokens with low-opacity gray-blue (e.g. `rgba(27, 31, 36, 0.08)`) and soften the shadow radius.

Declare `"scheme": "light"` in the manifest so Claudette loads the light syntax-highlight CSS and natives match.

---

## Development workflow

- **Live reload**: CSS changes hot-reload in the Tauri dev build. JSON theme edits require a theme re-select (Settings → Appearance → pick the theme again) or app restart.
- **Inspect**: `document.documentElement` style panel in devtools shows every active `--token`.
- **Schema validation**: point your editor at `theme.schema.json` (VS Code: `json.schemas` setting, or set `$schema` at the top of your theme file as in the skeleton).

## Back-compat: legacy flat shape

Older themes used a flat top-level structure:

```json
{
  "id": "old-theme",
  "name": "Old Theme",
  "colors": {
    "accent-primary": "#f00",
    "app-bg": "#111"
  }
}
```

This still works. `applyTheme()` detects the shape and flattens the `colors` map into CSS variables. New themes should prefer the structured `manifest` + `tokens` shape for schema validation and group readability.

---

## Extending the token set

Need to theme something that isn't currently a variable? Two-step patch:

1. Replace the hardcoded value in component CSS with `var(--your-token, fallback)`.
2. Add the token name to:
   - `theme.css` `:root` (default value)
   - `THEMEABLE_TOKENS` in `utils/theme.ts` (allowlist)
   - `theme.schema.json` (optional — for editor autocomplete)
   - This doc.

Every token that exists should be documented here, visible in the schema, and overridable in a theme file. That's the contract.
