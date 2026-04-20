import { useState } from "react";
import { ChevronRight } from "lucide-react";
import styles from "./SyntheticContinuationMessage.module.css";

interface SyntheticContinuationMessageProps {
  body: string;
}

/**
 * Renders the pre-compaction summary the CLI emits after `/compact`.
 * Collapsed-by-default to keep the timeline readable; click-to-expand
 * reveals the full summary text in a muted block. Visually consistent
 * with CompactionDivider (same hairline-with-centered-content style).
 */
export function SyntheticContinuationMessage({
  body,
}: SyntheticContinuationMessageProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={styles.container}>
      <div
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className={styles.line} aria-hidden="true" />
        <span className={styles.label}>
          <ChevronRight
            size={14}
            className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            aria-hidden="true"
          />
          Pre-compaction summary
        </span>
        <span className={styles.line} aria-hidden="true" />
      </div>
      {expanded && <div className={styles.body}>{body}</div>}
    </div>
  );
}
