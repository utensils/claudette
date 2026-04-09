import type { ThemeDefinition } from "../../types/theme";
import defaultDark from "./default-dark.json";
import defaultLight from "./default-light.json";
import midnightBlue from "./midnight-blue.json";
import warmEmber from "./warm-ember.json";
import highContrast from "./high-contrast.json";
import rosePine from "./rose-pine.json";
import rosePineMoon from "./rose-pine-moon.json";
import rosePineDawn from "./rose-pine-dawn.json";
import solarizedDark from "./solarized-dark.json";
import solarizedLight from "./solarized-light.json";
import jellybeans from "./jellybeans.json";
import jellybeansMuted from "./jellybeans-muted.json";

export const BUILTIN_THEMES: ThemeDefinition[] = [
  defaultDark,
  defaultLight,
  midnightBlue,
  warmEmber,
  highContrast,
  rosePine,
  rosePineMoon,
  rosePineDawn,
  solarizedDark,
  solarizedLight,
  jellybeans,
  jellybeansMuted,
];

export const DEFAULT_THEME_ID = "default-dark";
