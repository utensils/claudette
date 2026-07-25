import type { CompletedTurn, ToolActivity } from "./useAppStore";

/**
 * Find a tool activity by `toolUseId` across both places one can live.
 *
 * A tool activity starts in `toolActivities[sessionId]` while its turn is
 * running and migrates into `completedTurns[sessionId][N].activities` when
 * the turn ends — the `toolUseId` is preserved verbatim across that move.
 * Anything reading an activity outside the turn that created it therefore
 * has to check both, in that order.
 *
 * This mirrors the search `updateToolActivity` performs on the write side
 * (`chatSlice.ts`), including the newest-first scan of completed turns:
 * `toolUseId` is unique per turn, so the newest match is the only match,
 * and the relevant activity is almost always in the most recent turn.
 *
 * The backgrounded-`Workflow` case is why this exists as a read helper.
 * A workflow's turn is checkpointed within a second of launch, so by the
 * time its terminal `task_notification` arrives — minutes later — the
 * activity has long since moved into `completedTurns`.
 */
export function findToolActivity(
  state: {
    toolActivities: Record<string, ToolActivity[]>;
    completedTurns: Record<string, CompletedTurn[]>;
  },
  sessionId: string,
  toolUseId: string,
): ToolActivity | undefined {
  const live = state.toolActivities[sessionId]?.find(
    (a) => a.toolUseId === toolUseId,
  );
  if (live) return live;

  const turns = state.completedTurns[sessionId];
  if (!turns) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const match = turns[i].activities.find((a) => a.toolUseId === toolUseId);
    if (match) return match;
  }
  return undefined;
}
