import type { ThemeDefinition } from "../../types/theme";
import defaultTheme from "./default.json";
import claudetteTheme from "./claudette.json";
import velvetTheme from "./velvet.json";
import neonTokyoTheme from "./neon-tokyo.json";
import solarTheme from "./solar.json";
import bunkerTheme from "./bunker.json";
import greenhouseTheme from "./greenhouse.json";
import uplink1984Theme from "./uplink-1984.json";
import phosphorUplinkTheme from "./phosphor-uplink.json";

export const BUILTIN_THEMES: ThemeDefinition[] = [
  defaultTheme as ThemeDefinition,
  claudetteTheme as ThemeDefinition,
  velvetTheme as ThemeDefinition,
  neonTokyoTheme as ThemeDefinition,
  solarTheme as ThemeDefinition,
  bunkerTheme as ThemeDefinition,
  greenhouseTheme as ThemeDefinition,
  uplink1984Theme as ThemeDefinition,
  phosphorUplinkTheme as ThemeDefinition,
];

export const DEFAULT_THEME_ID = "default";
