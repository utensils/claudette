import { useState } from "react";
import { Brain } from "lucide-react";
import { useTypewriter } from "../../hooks/useTypewriter";
import styles from "./ThinkingBlock.module.css";
import caretStyles from "./caret.module.css";

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
  enableTypewriter?: boolean;
}

export function ThinkingBlock({ content, isStreaming, enableTypewriter }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { displayed, showCaret } = useTypewriter(content, isStreaming, {
    enabled: enableTypewriter && expanded,
  });

  if (!content) return null;

  const label = isStreaming ? "Thinking\u2026" : "Thinking";
  const visibleContent = enableTypewriter ? displayed : content;

  return (
    <div className={styles.container}>
      <button
        className={styles.header}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={`${styles.chevron} ${expanded ? styles.chevronExpanded : ""}`}>
          ›
        </span>
        <Brain size={14} />
        <span className={styles.label}>{label}</span>
      </button>
      {expanded && (
        <div className={styles.content}>
          {visibleContent}
          {showCaret && <span className={caretStyles.caret} aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
