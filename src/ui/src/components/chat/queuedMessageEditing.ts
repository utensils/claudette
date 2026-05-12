/**
 * Extract every closed `@path` token from `text` — i.e. an `@` at start of
 * string or preceded by whitespace, followed by a non-whitespace path.
 */
export function extractMentionPaths(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[2].replace(/[),.;:!?]+$/g, "");
    if (path) out.add(path);
  }
  return out;
}

export function resolveQueuedMentionFiles(
  content: string,
  previousMentionedFiles?: string[],
): string[] | undefined {
  const nextFiles = extractMentionPaths(content);
  for (const path of previousMentionedFiles ?? []) {
    if (content.includes(`@${path}`)) nextFiles.add(path);
  }
  return nextFiles.size > 0 ? [...nextFiles] : undefined;
}

interface AutoDispatchQueuedMessageArgs {
  isSteeringQueued: boolean;
  isRunning: boolean;
  activeSessionId: string | null;
  hasNextQueuedMessage: boolean;
  isEditingQueuedMessage: boolean;
  autoDispatchQueuedId: string | null;
}

export function shouldAutoDispatchQueuedMessage({
  isSteeringQueued,
  isRunning,
  activeSessionId,
  hasNextQueuedMessage,
  isEditingQueuedMessage,
  autoDispatchQueuedId,
}: AutoDispatchQueuedMessageArgs): boolean {
  return (
    !isSteeringQueued &&
    !isRunning &&
    !!activeSessionId &&
    hasNextQueuedMessage &&
    !isEditingQueuedMessage &&
    !autoDispatchQueuedId
  );
}

interface QueuedEditShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
}

export function isQueuedEditSaveShortcut(e: QueuedEditShortcutInput): boolean {
  return e.key === "Enter" && !e.shiftKey;
}

export function isQueuedEditCancelShortcut(e: QueuedEditShortcutInput): boolean {
  return e.key === "Escape";
}
