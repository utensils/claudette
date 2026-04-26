import { useAppStore } from "../../stores/useAppStore";

// Match POSIX absolute paths pointing at `.claude/plans/*.md`. Allows spaces
// in directory segments (macOS home directories with spaces are legitimate)
// but keeps the filename portion on a single path segment — otherwise a
// stretch of prose like "see /a/.claude/plans/x.txt or /b/y.md" would match
// across the intermediate directory boundary. Windows-style drive paths are
// intentionally not matched — Claudette only targets macOS and Linux (see
// CLAUDE.md).
const PLAN_PATH_RE =
  /(\/[^\r\n)"`]*?\/\.claude\/plans\/[^\r\n/)"`]+?\.md)(?=$|[\s)"'`.,:;!?])/;

/**
 * Locate the most recent plan file path for the given chat session by
 * scanning the current in-memory state — chat messages first (newest-first),
 * then the active streaming buffer, then tool-activity input/result text,
 * then the pending plan approval's `planFilePath`.
 *
 * Returns `null` if no `.claude/plans/*.md` path has been emitted yet.
 */
export function findLatestPlanFilePath(sessionId: string): string | null {
  const state = useAppStore.getState();

  const messages = state.chatMessages[sessionId] ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const match = messages[i].content.match(PLAN_PATH_RE);
    if (match) return match[1];
  }

  const streaming = state.streamingContent[sessionId] ?? "";
  const streamingMatch = streaming.match(PLAN_PATH_RE);
  if (streamingMatch) return streamingMatch[1];

  const activities = state.toolActivities[sessionId] ?? [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    const match = (activity.inputJson + activity.resultText).match(
      PLAN_PATH_RE,
    );
    if (match) return match[1];
  }

  return state.planApprovals[sessionId]?.planFilePath ?? null;
}
