/** Editor view constants shared by `MonacoEditor` and the menubar.
 *
 *  Lives here (not in `editor-menubar/useEditorActions.ts`) so the
 *  bare Monaco renderer doesn't have to import a module that pulls in
 *  Zustand, Tauri's clipboard plugin, and `setAppSetting`. Tree-shaking
 *  would strip those at bundle time, but the explicit decoupling keeps
 *  future additions to `useEditorActions` from accidentally widening
 *  `MonacoEditor`'s import surface. */

/** Base font size Monaco uses at zoom 1.0×. Multiplied by
 *  `editorFontZoom` from the store to compute the effective size. */
export const EDITOR_BASE_FONT_SIZE = 13;

/** Granularity of the View > Zoom In / Zoom Out menu items. */
export const EDITOR_ZOOM_STEP = 0.1;

/** Lower bound enforced by `setEditorFontZoom` and the
 *  `clampZoom` helper. Below this Monaco's measurements get unreliable
 *  (sub-9-pixel glyphs render poorly across renderers). */
export const EDITOR_ZOOM_MIN = 0.7;

/** Upper bound enforced by `setEditorFontZoom`. Anything higher and a
 *  realistic editor row count no longer fits the viewport. */
export const EDITOR_ZOOM_MAX = 2;
