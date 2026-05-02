import type { ConversationCheckpoint } from "../types/checkpoint";
import type { ChatMessage } from "../types/chat";

/**
 * Determine whether rolling back to a given checkpoint could involve
 * restoring file changes. New checkpoints use `has_file_state` (SQLite
 * snapshots). Legacy checkpoints fall back to comparing `commit_hash`
 * values.
 */
export function checkpointHasFileChanges(
  checkpoint: ConversationCheckpoint,
  allCheckpoints: ConversationCheckpoint[],
): boolean {
  // New snapshots: has_file_state is authoritative.
  if (checkpoint.has_file_state) return true;
  // Legacy: fall back to commit_hash comparison.
  if (!checkpoint.commit_hash) return false;
  if (allCheckpoints.length === 0) return false;
  const latest = allCheckpoints[allCheckpoints.length - 1];
  if (checkpoint.id === latest.id) return true;
  return checkpoint.commit_hash !== latest.commit_hash;
}

/**
 * Determine whether clearing the entire conversation could involve
 * restoring file changes. Returns true when any checkpoint has file state
 * (snapshot or legacy commit hash) — meaning the agent edited files at
 * some point.
 */
export function clearAllHasFileChanges(
  checkpoints: ConversationCheckpoint[],
): boolean {
  return checkpoints.some((c) => c.has_file_state || c.commit_hash !== null);
}

/**
 * Build a map of message index → checkpoint for rollback buttons.
 * Each User message gets mapped to the most recent checkpoint at or
 * before it, so users can always roll back — even past interrupted
 * turns that didn't produce a checkpoint.
 *
 * The first User message of the FULL conversation maps to `null`
 * (clear-all) — clearing the conversation doesn't require a checkpoint.
 * Subsequent User messages map to the most recent checkpoint seen so far.
 * Uses a single forward pass (O(n)) by tracking the latest checkpoint
 * while iterating.
 *
 * `globalOffset` is the number of older messages that exist in the session
 * but aren't in `messages` (pagination). When > 0 the top user message in
 * the loaded window is NOT the conversation root, so the clear-all sentinel
 * is suppressed for it: that user gets the latest preceding checkpoint
 * (or no entry if none has been seen yet — checkpoints belonging to older
 * pages will surface once the user scrolls them into view and the merged
 * window is re-evaluated). Defaults to 0 for fully-loaded sessions.
 */
export function buildRollbackMap(
  messages: ChatMessage[],
  checkpoints: ConversationCheckpoint[],
  globalOffset = 0,
): Map<number, ConversationCheckpoint | null> {
  const msgIdToCp = new Map(checkpoints.map((cp) => [cp.message_id, cp]));
  const result = new Map<number, ConversationCheckpoint | null>();
  let firstUser = globalOffset === 0;
  let latestCp: ConversationCheckpoint | undefined;

  for (let i = 0; i < messages.length; i++) {
    // Track the most recent checkpoint as we scan forward.
    const cp = msgIdToCp.get(messages[i].id);
    if (cp) latestCp = cp;

    if (messages[i].role === "User") {
      if (firstUser) {
        // First user message of the full conversation: clear-all.
        result.set(i, null);
        firstUser = false;
      } else if (latestCp) {
        result.set(i, latestCp);
      }
    }
  }
  return result;
}
