import type { ThemeDefinition } from "../../types/theme";
import { isStructuredTheme } from "../../types/theme";
import defaultTheme from "./default.json";
import claudetteTheme from "./claudette.json";
import linearTheme from "./linear.json";
import velvetTheme from "./velvet.json";
import roseTheme from "./rose.json";
import neonTokyoTheme from "./neon-tokyo.json";
import solarTheme from "./solar.json";
import gruvboxTheme from "./gruvbox.json";
import bunkerTheme from "./bunker.json";
import greenhouseTheme from "./greenhouse.json";
import uplink1984Theme from "./uplink-1984.json";
import phosphorUplinkTheme from "./phosphor-uplink.json";
import draculaTheme from "./dracula.json";
import tokyoNightTheme from "./tokyo-night.json";
import catppuccinMochaTheme from "./catppuccin-mocha.json";
import monokaiProTheme from "./monokai-pro.json";
import codexTheme from "./codex.json";

import defaultCss from "./stylesheets/default.css?url";
import claudetteCss from "./stylesheets/claudette.css?url";
import linearCss from "./stylesheets/linear.css?url";
import velvetCss from "./stylesheets/velvet.css?url";
import roseCss from "./stylesheets/rose.css?url";
import neonTokyoCss from "./stylesheets/neon-tokyo.css?url";
import solarCss from "./stylesheets/solar.css?url";
import gruvboxCss from "./stylesheets/gruvbox.css?url";
import bunkerCss from "./stylesheets/bunker.css?url";
import greenhouseCss from "./stylesheets/greenhouse.css?url";
import uplink1984Css from "./stylesheets/uplink-1984.css?url";
import phosphorUplinkCss from "./stylesheets/phosphor-uplink.css?url";
import draculaCss from "./stylesheets/dracula.css?url";
import tokyoNightCss from "./stylesheets/tokyo-night.css?url";
import catppuccinMochaCss from "./stylesheets/catppuccin-mocha.css?url";
import monokaiProCss from "./stylesheets/monokai-pro.css?url";
import codexCss from "./stylesheets/codex.css?url";

/**
 * Per-theme stylesheet URLs. Keyed by theme id. Each entry is a Vite
 * `?url` import so the CSS ships as a static asset but is only loaded
 * (by `applyTheme`) when the corresponding theme is active. To wire a
 * stylesheet for a theme, drop a CSS file in `./stylesheets/` and add
 * an entry here:
 *
 *   import fooCss from "./stylesheets/foo.css?url";
 *   const BUILTIN_STYLESHEETS: Record<string, string> = { foo: fooCss };
 *
 * Themes without an entry simply have no extra stylesheet — their
 * `manifest.stylesheet` is left undefined.
 */
const BUILTIN_STYLESHEETS: Record<string, string> = {
  default: defaultCss,
  claudette: claudetteCss,
  linear: linearCss,
  velvet: velvetCss,
  rose: roseCss,
  "neon-tokyo": neonTokyoCss,
  solar: solarCss,
  gruvbox: gruvboxCss,
  bunker: bunkerCss,
  greenhouse: greenhouseCss,
  "uplink-1984": uplink1984Css,
  "phosphor-uplink": phosphorUplinkCss,
  dracula: draculaCss,
  "tokyo-night": tokyoNightCss,
  "catppuccin-mocha": catppuccinMochaCss,
  "monokai-pro": monokaiProCss,
  codex: codexCss,
};

function withStylesheet(theme: ThemeDefinition): ThemeDefinition {
  const id = isStructuredTheme(theme) ? theme.manifest.id : theme.id;
  const url = BUILTIN_STYLESHEETS[id];
  if (!url) return theme;
  if (isStructuredTheme(theme)) {
    return {
      ...theme,
      manifest: { ...theme.manifest, stylesheet: url },
    };
  }
  return { ...theme, stylesheet: url };
}

export const BUILTIN_THEMES: ThemeDefinition[] = [
  defaultTheme as ThemeDefinition,
  claudetteTheme as ThemeDefinition,
  draculaTheme as ThemeDefinition,
  tokyoNightTheme as ThemeDefinition,
  catppuccinMochaTheme as ThemeDefinition,
  monokaiProTheme as ThemeDefinition,
  linearTheme as ThemeDefinition,
  velvetTheme as ThemeDefinition,
  roseTheme as ThemeDefinition,
  neonTokyoTheme as ThemeDefinition,
  solarTheme as ThemeDefinition,
  gruvboxTheme as ThemeDefinition,
  bunkerTheme as ThemeDefinition,
  greenhouseTheme as ThemeDefinition,
  uplink1984Theme as ThemeDefinition,
  phosphorUplinkTheme as ThemeDefinition,
  codexTheme as ThemeDefinition,
].map(withStylesheet);

export const DEFAULT_THEME_ID = "claudette";
