import type { ConversationCheckpoint } from "../types/checkpoint";

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
