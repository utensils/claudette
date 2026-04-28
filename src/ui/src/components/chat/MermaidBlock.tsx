import { memo, useEffect, useRef, useState } from "react";
import styles from "./MermaidBlock.module.css";

// Mermaid is heavy (~700 KB minified). Defer loading until a diagram is
// actually rendered, and reuse the same instance across all blocks for the
// rest of the session.
type MermaidApi = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        // securityLevel "strict" (default) sanitizes diagram source so
        // <script> and HTML embedded in node labels can't escape into the
        // page. We render mermaid output for both file previews (trusted)
        // and chat messages (less trusted), so the strict default is what
        // we want.
        securityLevel: "strict",
        theme: detectTheme(),
        fontFamily: "var(--font-sans)",
      });
      return m;
    });
  }
  return mermaidPromise;
}

function detectTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "dark";
  const declared = document.documentElement.style.colorScheme;
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
