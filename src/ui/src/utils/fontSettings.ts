import { useAppStore } from "../stores/useAppStore";
import { setAppSetting } from "../services/tauri";
import { applyUserFonts } from "./theme";

export const UI_FONT_SIZE_MIN = 10;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_DEFAULT = 13;

export function clampUiFontSize(size: number): number {
  return Math.max(UI_FONT_SIZE_MIN, Math.min(UI_FONT_SIZE_MAX, size));
}

/**
 * Adjust UI font size by `delta` (+1 or -1). Reads current state from
 * the store, clamps, applies to DOM, and persists to DB.
 * Shared by keyboard shortcuts, menu events, and command palette.
 */
export function adjustUiFontSize(delta: number): void {
  const s = useAppStore.getState();
  const next = clampUiFontSize(s.uiFontSize + delta);
  if (next === s.uiFontSize) return;
  s.setUiFontSize(next);
  applyUserFonts(s.fontFamilySans, s.fontFamilyMono, next);
  setAppSetting("ui_font_size", String(next)).catch(console.error);
}

/** Reset UI font size to default. */
export function resetUiFontSize(): void {
  const s = useAppStore.getState();
  s.setUiFontSize(UI_FONT_SIZE_DEFAULT);
  applyUserFonts(s.fontFamilySans, s.fontFamilyMono, UI_FONT_SIZE_DEFAULT);
  setAppSetting("ui_font_size", String(UI_FONT_SIZE_DEFAULT)).catch(console.error);
}

export interface FontOption {
  value: string;
  label: string;
  group?: "sans" | "mono";
}

/** Heuristic: does a font family name look monospaced? */
const MONO_KEYWORDS = /\b(mono|code|consol|courier|menlo|monaco|terminal|fixed|hack|iosevka|pragmata|victor|fira\s*code|source\s*code|jetbrains|cascadia|sf\s*mono|inconsolata|droid\s*sans\s*mono|ubuntu\s*mono|roboto\s*mono|ibm\s*plex\s*mono|noto\s*sans\s*mono|liberation\s*mono|anonymous\s*pro|fantasque|commit\s*mono|geist\s*mono|maple\s*mono|monaspace|intel\s*one\s*mono|0xproto|monocraft)\b/i;

/**
 * Build font option lists from system-installed fonts.
 * Both lists contain ALL fonts, with the relevant category sorted first.
 * Each font carries a `group` tag ("sans" | "mono") for rendering group headers.
 */
export function buildFontOptions(systemFonts: string[]): {
  sans: FontOption[];
  mono: FontOption[];
} {
  const sansGroup: FontOption[] = [];
  const monoGroup: FontOption[] = [];

  for (const name of systemFonts) {
    if (name.startsWith(".") || name.startsWith("#")) continue;
    if (MONO_KEYWORDS.test(name)) {
      monoGroup.push({ value: name, label: name, group: "mono" });
    } else {
      sansGroup.push({ value: name, label: name, group: "sans" });
    }
  }

  const sans: FontOption[] = [
    { value: "", label: "Default (Inter)" },
    ...sansGroup,
    ...monoGroup,
    { value: "__custom__", label: "Custom..." },
  ];

  const mono: FontOption[] = [
    { value: "", label: "Default (JetBrains Mono)" },
    ...monoGroup,
    ...sansGroup,
    { value: "__custom__", label: "Custom..." },
  ];

  return { sans, mono };
}
