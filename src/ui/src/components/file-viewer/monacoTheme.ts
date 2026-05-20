import type * as MonacoType from "monaco-editor";

function h(n: string): string {
  return parseInt(n).toString(16).padStart(2, "0");
}

/** Resolve a CSS custom property to a concrete sRGB color string.
 *  Necessary because `getComputedStyle(root).getPropertyValue("--x")`
 *  returns the *specified* value, which after PR #799's refactor includes
 *  `var(--text-faint)` and `color-mix(in srgb, ...)` expressions. Monaco
 *  needs concrete hex; those expressions can only be resolved by laying
 *  out an element that uses them, then reading the COMPUTED `color`.
 *
 *  We reuse a single hidden element across calls within one
 *  applyMonacoTheme invocation to keep DOM churn low. Returns the raw
 *  fallback if the prop is unset or the resolver fails — the caller's
 *  outer `cssColorToHex` will pass that through to Monaco. */
interface ColorResolver {
  resolve: (prop: string, fallback: string) => string;
  dispose: () => void;
}

function makeColorResolver(): ColorResolver {
  // Cache the probe element + getComputedStyle reference across reads
  // — one Insert/Remove per applyMonacoTheme call instead of N.
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(probe);
  return {
    resolve: (prop, fallback) => {
      // Setting `color: var(--x)` forces the browser to resolve the var
      // chain (including any nested color-mix()) and store the concrete
      // result. Reading `getComputedStyle.color` then returns a concrete
      // sRGB color string the caller can convert to hex.
      probe.style.color = "";
      probe.style.color = `var(${prop})`;
      const resolved = getComputedStyle(probe).color.trim();
      // If the var is unset or the value is unparseable, the browser
      // either leaves `color` empty or falls back to its initial value.
      // The format sniff distinguishes a real color from those cases.
      if (!resolved || !/^rgb/.test(resolved)) return fallback;
      return resolved;
    },
    dispose: () => probe.remove(),
  };
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
  // We resolve every CSS variable via a hidden probe element rather than
  // raw `getPropertyValue`. This is critical after PR #799's color-mix
  // refactor: tokens like `--accent-bg` and `--syntax-comment` are now
  // declared via `color-mix(...)` or `var(--text-faint)` chains, and
  // `getPropertyValue` returns the *literal expression* (e.g.
  // `"color-mix(in srgb, var(--accent-primary) 8%, transparent)"`),
  // which Monaco can't parse. The probe-based resolver reads the
  // browser's COMPUTED color, which is always a concrete sRGB color
  // string.
  //
  // Hex fallbacks in each call mirror :root in theme.css; they only
  // kick in if the stylesheet hasn't loaded yet (or the var chain is
  // broken) so Monaco never receives an empty/invalid color.
  const cs = getComputedStyle(document.documentElement);
  const isDark = (cs.getPropertyValue("--color-scheme").trim() || "dark") !== "light";
  const base: MonacoType.editor.BuiltinTheme = isDark ? "vs-dark" : "vs";

  const { resolve, dispose } = makeColorResolver();
  try {
    const bg        = cssColorToHex(resolve("--app-bg", isDark ? "#1c1815" : "#ffffff"));
    const fg        = cssColorToHex(resolve("--text-primary", isDark ? "#f0ebe5" : "#1a1a1a"));
    const muted     = cssColorToHex(resolve("--text-muted", isDark ? "#b8afa5" : "#666666"));
    const dim       = cssColorToHex(resolve("--text-dim", isDark ? "#908880" : "#999999"));
    const accent    = cssColorToHex(resolve("--accent-primary", isDark ? "#e07850" : "#c45a35"));
    const accentBg  = cssColorToHex(resolve("--accent-bg", isDark ? "#1a1a1a" : "#f5f5f5"));
    const selected  = cssColorToHex(resolve("--selected-bg", isDark ? "#3a2820" : "#f0e8e0"));
    const hovered   = cssColorToHex(resolve("--hover-bg", isDark ? "#242220" : "#f5f5f5"));
    const scrollbarThumb = cssColorToHex(resolve("--scrollbar-thumb", isDark ? "#242220" : "#f5f5f5"));
    const scrollbarThumbHover = cssColorToHex(resolve("--scrollbar-thumb-hover", isDark ? "#e0785040" : "#c45a3540"));
    const divider   = cssColorToHex(resolve("--divider", isDark ? "#3d3832" : "#e0e0e0"));
    const widgetBg  = cssColorToHex(resolve("--sidebar-bg", isDark ? "#26221f" : "#f5f5f5"));
    const addedBg   = cssColorToHex(resolve("--diff-added-bg", isDark ? "#1a3a20" : "#e8f5e9"));
    const removedBg = cssColorToHex(resolve("--diff-removed-bg", isDark ? "#3a1a1a" : "#ffebee"));
    const addedFg   = cssColorToHex(resolve("--diff-added-text", isDark ? "#6ccc80" : "#2e7d32"));
    const removedFg = cssColorToHex(resolve("--diff-removed-text", isDark ? "#f07070" : "#c62828"));

    // Syntax tokens — fallbacks match :root in theme.css.
    const syntaxKeyword  = cssColorToHex(resolve("--syntax-keyword", isDark ? "#c0a0f0" : "#6848a8"));
    const syntaxString   = cssColorToHex(resolve("--syntax-string", isDark ? "#6ccc80" : "#1a7f37"));
    const syntaxNumber   = cssColorToHex(resolve("--syntax-number", isDark ? "#f0a050" : "#c27430"));
    const syntaxComment  = cssColorToHex(resolve("--syntax-comment", isDark ? "#686058" : "#b8afa5"));
    const syntaxFunction = cssColorToHex(resolve("--syntax-function", isDark ? "#8cb8e0" : "#3d6da0"));
    const syntaxType     = cssColorToHex(resolve("--syntax-type", isDark ? "#e0c050" : "#a07820"));
    const syntaxVariable = cssColorToHex(resolve("--syntax-variable", isDark ? "#f07070" : "#c42020"));
    const syntaxOperator = cssColorToHex(resolve("--syntax-operator", isDark ? "#6cb6ff" : "#1d6fa5"));
    const transparent = withAlpha(bg, "00");

  monaco.editor.defineTheme("claudette", {
    base,
    inherit: true,
    rules: [
      // Token rules use the canonical --syntax-* family so Monaco stays in
      // visual lockstep with Shiki-rendered code blocks in chat. Inherits
      // unspecified tokens from vs-dark/vs so we don't have to enumerate
      // every grammar's scope set.
      { token: "comment",          foreground: token6(syntaxComment), fontStyle: "italic" },
      { token: "keyword",          foreground: token6(syntaxKeyword) },
      { token: "string",           foreground: token6(syntaxString) },
      { token: "string.escape",    foreground: token6(syntaxOperator) },
      { token: "number",           foreground: token6(syntaxNumber) },
      { token: "regexp",           foreground: token6(syntaxOperator) },
      { token: "type",             foreground: token6(syntaxType) },
      { token: "function",         foreground: token6(syntaxFunction) },
      { token: "variable",         foreground: token6(syntaxVariable) },
      { token: "delimiter",        foreground: token6(syntaxOperator) },
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
  } finally {
    // Remove the probe element even if Monaco's defineTheme throws,
    // otherwise repeated theme rebuilds (via the MutationObserver in
    // initMonacoThemeSync) would leak detached <span>s.
    dispose();
  }
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
