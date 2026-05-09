import { memo, useContext, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { StreamingContext } from "./StreamingContext";
import { ScrollContext } from "./ScrollContext";
import styles from "./ChatPanel.module.css";

export const StreamingMessage = memo(function StreamingMessage({
  sessionId,
  isStreaming,
  searchQuery,
}: {
  sessionId: string;
  isStreaming: boolean;
  searchQuery: string;
}) {
  const streaming = useAppStore((s) => s.streamingContent[sessionId] || "");
  const { handleContentChanged } = useContext(ScrollContext);

  useEffect(() => {
    handleContentChanged();
  }, [streaming, handleContentChanged]);

  if (!streaming) return null;

  return (
    <div
      className={`${styles.message} ${styles.role_Assistant}`}
      aria-live="polite"
      aria-busy={isStreaming}
    >
      <div className={styles.content}>
        <StreamingContext.Provider value={isStreaming}>
          <HighlightedMessageMarkdown content={streaming} query={searchQuery} />
        </StreamingContext.Provider>
      </div>
    </div>
  );
});
