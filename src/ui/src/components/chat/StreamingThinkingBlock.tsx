import { memo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { ThinkingBlock } from "./ThinkingBlock";

/**
 * Isolated thinking block — subscribes to streamingThinking to avoid
 * re-rendering ChatPanel on every thinking delta.
 */
export const StreamingThinkingBlock = memo(function StreamingThinkingBlock({
  sessionId,
  isStreaming,
  searchQuery,
}: {
  sessionId: string;
  isStreaming: boolean;
  searchQuery: string;
}) {
  const thinking = useAppStore((s) => s.streamingThinking[sessionId] || "");
  if (!thinking) return null;
  return (
    <ThinkingBlock
      content={thinking}
      isStreaming={isStreaming}
      enableTypewriter
      searchQuery={searchQuery}
    />
  );
});
