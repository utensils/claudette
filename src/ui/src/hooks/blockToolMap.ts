/** What we track per content-block-start of type tool_use. */
export type BlockToolEntry = { toolUseId: string; toolName: string };

/**
 * Per-session map: sessionId → (content-block index → tool entry).
 *
 * The Anthropic streaming protocol numbers content blocks within a single
 * stream — so two concurrent sessions routinely reuse the same indices
 * (e.g. block 0). Keying by sessionId prevents one session's tool ids from
 * clobbering another's, and lets ProcessExited clean up only the exiting
 * session without touching the rest.
 */
export type BlockToolMap = Record<string, Record<number, BlockToolEntry>>;

export function setBlockTool(
  map: BlockToolMap,
  sessionId: string,
  blockIndex: number,
  entry: BlockToolEntry,
): void {
  (map[sessionId] ??= {})[blockIndex] = entry;
}

export function getBlockTool(
  map: BlockToolMap,
  sessionId: string,
  blockIndex: number,
): BlockToolEntry | undefined {
  return map[sessionId]?.[blockIndex];
}

export function clearBlockToolsForSession(
  map: BlockToolMap,
  sessionId: string,
): void {
  delete map[sessionId];
}
