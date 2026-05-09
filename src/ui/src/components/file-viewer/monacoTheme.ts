import type * as MonacoType from "monaco-editor";

function h(n: string): string {
  return parseInt(n).toString(16).padStart(2, "0");
}

/** Convert any CSS color string to a Monaco-compatible 8-char-or-6-char hex.
 *  If the input is already a hex literal it's returned as-is so safety
 *  fallbacks (`getPropertyValue(...).trim() || "#..."`) flow through
 *  unchanged. Returns the raw input verbatim when the format is
 *  unrecognised — Monaco will reject it loudly, which is preferable to
 *  silently swapping in a wrong colour. */
function cssColorToHex(raw: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw;
  const short = raw.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = raw.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`;
  const rgba = raw.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgba) {
    const a = Math.round(parseFloat(rgba[4]) * 255);
    return `#${h(rgba[1])}${h(rgba[2])}${h(rgba[3])}${h(String(a))}`;
  }
  return raw;
}

/** Strip alpha from a hex color and append a two-char alpha hex (00–ff).
 *  Used to derive transparent / partially-transparent overlays from a
 *  base token so the literal transparent is never spelled in this file. */
function withAlpha(hex: string, alphaHex: string): string {
  return hex.slice(0, 7) + alphaHex;
}

/** Six-digit hex without '#', for Monaco token rule foreground values. */
function token6(hex: string): string {
  return hex.slice(1, 7);
}

export function applyMonacoTheme(monaco: typeof MonacoType): void {
  // Inline `getPropertyValue("--x").trim() || "#…"` is the canonical
  // safety-fallback pattern allowed by `scripts/check-css-tokens.sh`. The
  // fallbacks mirror the corresponding tokens in `src/styles/theme.css`
  // and only kick in if the stylesheet hasn't loaded yet — they exist so
  // Monaco never receives an empty colour string. Keep them in sync if
  // those tokens move.
  const cs = getComputedStyle(document.documentElement);
  const isDark = (cs.getPropertyValue("--color-scheme").trim() || "dark") !== "light";
  const base: MonacoType.editor.BuiltinTheme = isDark ? "vs-dark" : "vs";

  const bg        = cssColorToHex(cs.getPropertyValue("--app-bg").trim()           || (isDark ? "#1c1815" : "#ffffff"));
  const fg        = cssColorToHex(cs.getPropertyValue("--text-primary").trim()     || (isDark ? "#f0ebe5" : "#1a1a1a"));
  const muted     = cssColorToHex(cs.getPropertyValue("--text-muted").trim()       || (isDark ? "#b8afa5" : "#666666"));
  const dim       = cssColorToHex(cs.getPropertyValue("--text-dim").trim()         || (isDark ? "#908880" : "#999999"));
  const accent    = cssColorToHex(cs.getPropertyValue("--accent-primary").trim()   || (isDark ? "#e07850" : "#c45a35"));
  const accentBg  = cssColorToHex(cs.getPropertyValue("--accent-bg").trim()        || (isDark ? "#1a1a1a" : "#f5f5f5"));
  const selected  = cssColorToHex(cs.getPropertyValue("--selected-bg").trim()      || (isDark ? "#3a2820" : "#f0e8e0"));
  const hovered   = cssColorToHex(cs.getPropertyValue("--hover-bg").trim()         || (isDark ? "#242220" : "#f5f5f5"));
  const scrollbarThumb = cssColorToHex(cs.getPropertyValue("--scrollbar-thumb").trim() || (isDark ? "#242220" : "#f5f5f5"));
  const scrollbarThumbHover = cssColorToHex(cs.getPropertyValue("--scrollbar-thumb-hover").trim() || (isDark ? "#e0785040" : "#c45a3540"));
  const divider   = cssColorToHex(cs.getPropertyValue("--divider").trim()          || (isDark ? "#3d3832" : "#e0e0e0"));
  const widgetBg  = cssColorToHex(cs.getPropertyValue("--sidebar-bg").trim()       || (isDark ? "#26221f" : "#f5f5f5"));
  const addedBg   = cssColorToHex(cs.getPropertyValue("--diff-added-bg").trim()    || (isDark ? "#1a3a20" : "#e8f5e9"));
  const removedBg = cssColorToHex(cs.getPropertyValue("--diff-removed-bg").trim()  || (isDark ? "#3a1a1a" : "#ffebee"));
  const addedFg   = cssColorToHex(cs.getPropertyValue("--diff-added-text").trim()  || (isDark ? "#6ccc80" : "#2e7d32"));
  const removedFg = cssColorToHex(cs.getPropertyValue("--diff-removed-text").trim()|| (isDark ? "#f07070" : "#c62828"));
  const numberFg  = cssColorToHex(cs.getPropertyValue("--badge-plan").trim()       || (isDark ? "#8cb8e0" : "#4a8ab0"));
  const transparent = withAlpha(bg, "00");

  monaco.editor.defineTheme("claudette", {
    base,
    inherit: true,
    rules: [
      // Inherit all token colours from vs-dark/vs; only nudge a handful to
      // match Claudette's palette so the editor feels native rather than
      // jarring against the surrounding UI chrome.
      { token: "comment",          foreground: token6(dim),       fontStyle: "italic" },
      { token: "keyword",          foreground: token6(accent) },
      { token: "string",           foreground: token6(addedFg) },
      { token: "string.escape",    foreground: token6(accent) },
      { token: "number",           foreground: token6(numberFg) },
      { token: "regexp",           foreground: token6(removedFg) },
      { token: "delimiter",        foreground: token6(muted) },
    ],
    colors: {
      // Editor surface
      "editor.background":                      bg,
      "editor.foreground":                      fg,
      "editorGutter.background":                bg,

      // Line numbers
      "editorLineNumber.foreground":            dim,
      "editorLineNumber.activeForeground":      muted,

      // Cursor
      "editorCursor.foreground":                accent,
      "editorCursor.background":                bg,

      // Selection & highlight
      "editor.selectionBackground":             selected,
      "editor.inactiveSelectionBackground":     withAlpha(selected, "60"),
      "editor.selectionHighlightBackground":    accentBg,
      "editor.wordHighlightBackground":         accentBg,
      "editor.wordHighlightStrongBackground":   selected,

      // Current line
      "editor.lineHighlightBackground":         hovered,
      "editor.lineHighlightBorder":             transparent,

      // Find/match
      "editor.findMatchBackground":             withAlpha(accent, "40"),
      "editor.findMatchHighlightBackground":    withAlpha(accent, "20"),
      "editor.findMatchBorder":                 withAlpha(accent, "80"),

      // Widgets (suggest, hover, find)
      "editorWidget.background":                widgetBg,
      "editorWidget.border":                    divider,
      "editorWidget.foreground":                fg,
      "editorSuggestWidget.background":         widgetBg,
      "editorSuggestWidget.border":             divider,
      "editorSuggestWidget.foreground":         fg,
      "editorSuggestWidget.highlightForeground": accent,
      "editorSuggestWidget.selectedBackground": selected,
      "editorSuggestWidget.selectedForeground": fg,
      "editorHoverWidget.background":           widgetBg,
      "editorHoverWidget.border":               divider,
      "editorHoverWidget.foreground":           fg,

      // Input (inside find widget, rename prompt)
      "input.background":                       bg,
      "input.foreground":                       fg,
      "input.border":                           divider,
      "input.placeholderForeground":            dim,
      "inputOption.activeBackground":           selected,
      "inputOption.activeForeground":           fg,
      "inputOption.activeBorder":               accent,

      // Focus ring
      "focusBorder":                            accent,

      // Lists (suggest dropdown, breadcrumb)
      "list.hoverBackground":                   hovered,
      "list.activeSelectionBackground":         selected,
      "list.activeSelectionForeground":         fg,
      "list.inactiveSelectionBackground":       withAlpha(selected, "60"),
      "list.highlightForeground":               accent,

      // Scrollbars
      "scrollbar.shadow":                       transparent,
      "scrollbarSlider.background":             scrollbarThumb,
      "scrollbarSlider.hoverBackground":        scrollbarThumbHover,
      "scrollbarSlider.activeBackground":       scrollbarThumbHover,

      // Diff editor
      "diffEditor.insertedTextBackground":      addedBg,
      "diffEditor.removedTextBackground":       removedBg,
      "diffEditor.insertedLineBackground":      addedBg,
      "diffEditor.removedLineBackground":       removedBg,
      "diffEditorGutter.insertedLineBackground": addedBg,
      "diffEditorGutter.removedLineBackground": removedBg,

      // Minimap (disabled, but just in case)
      "minimap.background":                     bg,
      "minimapSlider.background":               withAlpha(dim, "30"),
      "minimapSlider.hoverBackground":          withAlpha(dim, "50"),
      "minimapSlider.activeBackground":         withAlpha(accent, "50"),

      // Breadcrumbs
      "breadcrumb.foreground":                  dim,
      "breadcrumb.focusForeground":             fg,
      "breadcrumb.activeSelectionForeground":   muted,
      "breadcrumbPicker.background":            widgetBg,

      // Peek view (go-to-definition inline)
      "peekView.border":                        accent,
      "peekViewEditor.background":              bg,
      "peekViewEditor.matchHighlightBackground": withAlpha(accent, "30"),
      "peekViewResult.background":              widgetBg,
      "peekViewResult.fileForeground":          fg,
      "peekViewResult.lineForeground":          muted,
      "peekViewResult.matchHighlightBackground": withAlpha(accent, "30"),
      "peekViewResult.selectionBackground":     selected,
      "peekViewResult.selectionForeground":     fg,
      "peekViewTitle.background":               widgetBg,
      "peekViewTitleLabel.foreground":          fg,
      "peekViewTitleDescription.foreground":    dim,

      // Status-bar colour tokens used when editor is embedded
      "editorOverviewRuler.border":             divider,
      "editorOverviewRuler.findMatchForeground": withAlpha(accent, "80"),
      "editorOverviewRuler.selectionHighlightForeground": withAlpha(accent, "60"),

      // Error / warning squiggles inherit from base, so we only need
      // to set the gutter icon colours to keep contrast on our bg.
      "editorError.foreground":                 removedFg,
      "editorWarning.foreground":               addedFg,
    },
  });

  monaco.editor.setTheme("claudette");
}

/** Apply the theme once, then keep it in sync with `data-theme` / inline
 *  style attribute changes on `<html>`. Returns a cleanup function. */
export function initMonacoThemeSync(monaco: typeof MonacoType): () => void {
  applyMonacoTheme(monaco);

  const observer = new MutationObserver(() => applyMonacoTheme(monaco));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });

  return () => observer.disconnect();
}
