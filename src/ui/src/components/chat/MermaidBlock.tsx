import { memo, useEffect, useRef, useState } from "react";
import styles from "./MermaidBlock.module.css";

// Mermaid is heavy (~700 KB minified). Defer loading until a diagram is
// actually rendered, and reuse the imported module across all blocks for
// the rest of the session. Re-initialize when the app theme changes so
// subsequent renders pick up the current color scheme — built-in themes
// switch via CSS without a full reload, and a cached mermaid instance
// would otherwise keep emitting the old palette.
type MermaidApi = typeof import("mermaid").default;
let mermaidModulePromise: Promise<MermaidApi> | null = null;
let initializedTheme: "dark" | "default" | null = null;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((mod) => mod.default);
  }
  const m = await mermaidModulePromise;
  const theme = detectTheme();
  if (initializedTheme !== theme) {
    m.initialize({
      startOnLoad: false,
      // securityLevel "strict" (default) sanitizes diagram source so
      // <script> and HTML embedded in node labels can't escape into the
      // page. We render mermaid output for both file previews (trusted)
      // and chat messages (less trusted), so the strict default is what
      // we want.
      securityLevel: "strict",
      theme,
      fontFamily: "var(--font-sans)",
    });
    initializedTheme = theme;
  }
  return m;
}

// Built-in themes set the scheme via CSS (`--color-scheme` custom property
// + a `color-scheme: var(--color-scheme)` rule on `<html>`); user JSON
// themes set inline `style.colorScheme` directly (theme.ts:191). Read the
// computed CSS variable first, then the resolved `colorScheme`, then the
// inline style, then fall back to the OS preference. This covers both
// theme paths plus pre-hydration where neither is set yet.
function detectTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "dark";
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const declared =
    computed.getPropertyValue("--color-scheme").trim().toLowerCase() ||
    computed.colorScheme.trim().toLowerCase() ||
    root.style.colorScheme.trim().toLowerCase();
  if (declared === "light") return "default";
  if (declared === "dark") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default";
}

// Stable counter for mermaid render IDs. Mermaid mutates the document during
// `render()` and the ID it returns is also stamped into the SVG, so each call
// needs a unique value.
let renderCounter = 0;

interface Props {
  /** Raw mermaid source (the contents of a ```mermaid fenced block). */
  source: string;
}

/**
 * Renders a mermaid diagram. Falls back to the source code in a `<pre>` if
 * mermaid fails to parse the input — common with mid-stream agent output
 * where the closing fence hasn't arrived yet, or when a user types invalid
 * syntax in a markdown file.
 */
export const MermaidBlock = memo(function MermaidBlock({ source }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Drop the previously rendered SVG so a streaming or edited source
    // doesn't keep showing the stale diagram while the new render is in
    // flight — the loading state takes over instead.
    setSvg(null);
    setError(null);
    loadMermaid()
      .then(async (mermaid) => {
        const id = `mermaid-${++renderCounter}`;
        try {
          const result = await mermaid.render(id, source);
          if (cancelled) return;
          setSvg(result.svg);
          // Some diagrams (sequence, gantt) bind interaction handlers via
          // bindFunctions — call after the SVG is in the DOM.
          queueMicrotask(() => {
            if (cancelled) return;
            if (result.bindFunctions && containerRef.current) {
              result.bindFunctions(containerRef.current);
            }
          });
        } catch (e) {
          if (cancelled) return;
          setSvg(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className={styles.error}>
        <div className={styles.errorLabel}>Mermaid diagram failed to render</div>
        <pre className={styles.errorSource}>{source}</pre>
        <div className={styles.errorMessage}>{error}</div>
      </div>
    );
  }

  if (svg === null) {
    return <div className={styles.loading}>Rendering diagram…</div>;
  }

  return (
    <div
      ref={containerRef}
      className={styles.diagram}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
