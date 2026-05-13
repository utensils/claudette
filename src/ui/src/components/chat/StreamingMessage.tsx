import { memo, useCallback, useContext, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { useTypewriter } from "../../hooks/useTypewriter";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { StreamingContext } from "./StreamingContext";
import { ScrollContext } from "./ScrollContext";
import { monacoFileLinkPath } from "./chatFileLinks";
import styles from "./ChatPanel.module.css";
import caretStyles from "./caret.module.css";

/**
 * Isolated streaming message component — runs the typewriter reveal at a steady
 * rate while the agent streams, and keeps draining the latched text after
 * streamingContent clears so the transition to the completed message is smooth
 * (the just-added chat message is hidden behind pendingTypewriter until drain
 * completes).
 */
export const StreamingMessage = memo(function StreamingMessage({
  sessionId,
  workspaceId,
  isStreaming,
  searchQuery,
}: {
  sessionId: string;
  workspaceId: string;
  isStreaming: boolean;
  searchQuery: string;
}) {
  const streaming = useAppStore((s) => s.streamingContent[sessionId] || "");
  const pendingText = useAppStore(
    (s) => s.pendingTypewriter[sessionId]?.text ?? "",
  );
  const finishTypewriterDrain = useAppStore((s) => s.finishTypewriterDrain);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const worktreePath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktree_path,
  );
  const { handleContentChanged } = useContext(ScrollContext);

  const fullText = streaming || pendingText;
  const { displayed, showCaret } = useTypewriter(fullText, isStreaming);

  useEffect(() => {
    handleContentChanged();
  }, [displayed, handleContentChanged]);

  // Drain complete + we're in pending-typewriter phase → release the hidden
  // completed message so it takes over visually without a jump. Also clears
  // streamingThinking in the same store update so StreamingThinkingBlock
  // unmounts atomically with the completed message unhiding.
  useEffect(() => {
    if (!showCaret && !streaming && pendingText) {
      finishTypewriterDrain(sessionId);
    }
  }, [showCaret, streaming, pendingText, sessionId, finishTypewriterDrain]);

  const openFileInMonaco = useCallback(
    (filePath: string) => {
      const rel = monacoFileLinkPath(filePath, worktreePath);
      if (!rel) return false;
      openFileTab(workspaceId, rel);
      return true;
    },
    [openFileTab, workspaceId, worktreePath],
  );

  if (!displayed) return null;

  return (
    <div
      className={`${styles.message} ${styles.role_Assistant}`}
      aria-live="polite"
      aria-busy={isStreaming}
    >
      <div className={styles.content}>
        <StreamingContext.Provider value={isStreaming || pendingText.length > 0}>
          <HighlightedMessageMarkdown
            content={displayed}
            query={searchQuery}
            onOpenFile={openFileInMonaco}
          />
        </StreamingContext.Provider>
        {showCaret && <span className={caretStyles.caret} aria-hidden="true" />}
      </div>
    </div>
  );
});
