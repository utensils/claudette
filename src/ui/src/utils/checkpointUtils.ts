import type { ConversationCheckpoint } from "../types/checkpoint";
import type { ChatMessage } from "../types/chat";

/**
 * Determine whether rolling back to a given checkpoint could involve
 * restoring file changes. Returns false only when the checkpoint has no
 * commit hash, or when a later checkpoint confirms the same hash (meaning
 * no files changed between the two). When the target is the latest
 * checkpoint we conservatively return true since the worktree may have
 * drifted after that checkpoint was created.
 */
export function checkpointHasFileChanges(
  checkpoint: ConversationCheckpoint,
  allCheckpoints: ConversationCheckpoint[],
): boolean {
  if (!checkpoint.commit_hash) return false;
  if (allCheckpoints.length === 0) return false;
  const latest = allCheckpoints[allCheckpoints.length - 1];
  // If this IS the latest checkpoint we can't be sure files haven't
  // drifted — conservatively offer restore.
  if (checkpoint.id === latest.id) return true;
  return checkpoint.commit_hash !== latest.commit_hash;
}

/**
 * Build a map of message index → checkpoint for rollback buttons.
 * Each User message gets mapped to the most recent checkpoint at or
 * before it, so users can always roll back — even past interrupted
 * turns that didn't produce a checkpoint.
 *
 * The first User message always maps to `null` (clear-all) — clearing the
 * conversation doesn't require a checkpoint. Subsequent User messages map
 * to the most recent checkpoint seen so far. Uses a single forward pass
 * (O(n)) by tracking the latest checkpoint while iterating.
 */
export function buildRollbackMap(
  messages: ChatMessage[],
  checkpoints: ConversationCheckpoint[],
): Map<number, ConversationCheckpoint | null> {
  const msgIdToCp = new Map(checkpoints.map((cp) => [cp.message_id, cp]));
  const result = new Map<number, ConversationCheckpoint | null>();
  let firstUser = true;
  let latestCp: ConversationCheckpoint | undefined;

  for (let i = 0; i < messages.length; i++) {
    // Track the most recent checkpoint as we scan forward.
    const cp = msgIdToCp.get(messages[i].id);
    if (cp) latestCp = cp;

    if (messages[i].role === "User") {
      if (firstUser) {
        // First user message always gets clear-all (no checkpoint needed).
        result.set(i, null);
        firstUser = false;
      } else if (latestCp) {
        result.set(i, latestCp);
      }
    }
  }
  return result;
}
