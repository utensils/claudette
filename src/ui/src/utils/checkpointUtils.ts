import type { ConversationCheckpoint } from "../types/checkpoint";

/**
 * Determine whether rolling back to a given checkpoint would involve
 * restoring file changes. Returns true only when the checkpoint has a
 * commit hash that differs from the latest checkpoint's hash — meaning
 * actual file modifications occurred after this checkpoint.
 */
export function checkpointHasFileChanges(
  checkpoint: ConversationCheckpoint,
  allCheckpoints: ConversationCheckpoint[],
): boolean {
  if (!checkpoint.commit_hash) return false;
  if (allCheckpoints.length === 0) return false;
  const latest = allCheckpoints[allCheckpoints.length - 1];
  return checkpoint.commit_hash !== latest.commit_hash;
}
