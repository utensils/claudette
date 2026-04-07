import type { ThemeDefinition } from "../../types/theme";
import defaultDark from "./default-dark.json";
import midnightBlue from "./midnight-blue.json";
import warmEmber from "./warm-ember.json";
import highContrast from "./high-contrast.json";
import rosePine from "./rose-pine.json";
import rosePineMoon from "./rose-pine-moon.json";

export const BUILTIN_THEMES: ThemeDefinition[] = [
  defaultDark,
  midnightBlue,
  warmEmber,
  highContrast,
  rosePine,
  rosePineMoon,
];

export const DEFAULT_THEME_ID = "default-dark";
