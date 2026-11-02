import { sendRemoteCommand } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { applyAgentPermissionPrompt } from "../../hooks/useAgentStream";

/** One entry of a `get_chat_snapshot` response's `pending_controls`. */
export interface PendingAgentControl {
  tool_use_id: string;
  tool_name: string;
  input: unknown;
}

function cardToolUseId(sessionId: string): string | null {
  const s = useAppStore.getState();
  return (
    s.agentQuestions[sessionId]?.toolUseId ??
    s.planApprovals[sessionId]?.toolUseId ??
    s.agentApprovals[sessionId]?.toolUseId ??
    null
  );
}

function clearCard(sessionId: string): void {
  const s = useAppStore.getState();
  if (s.agentQuestions[sessionId]) s.clearAgentQuestion(sessionId);
  if (s.planApprovals[sessionId]) s.clearPlanApproval(sessionId);
  if (s.agentApprovals[sessionId]) s.clearAgentApproval(sessionId);
}

/**
 * Reconcile a session's approval card with the server's pending controls.
 *
 * `cardBefore` is the card's `toolUseId` when the snapshot was requested.
 * If the card changed while the snapshot was in flight (a live prompt
 * arrived, or the user answered and cleared it), the snapshot is older than
 * what's showing and is ignored. Otherwise a card that is no longer pending
 * was answered elsewhere and is cleared.
 */
export function reconcilePendingControls(
  sessionId: string,
  controls: PendingAgentControl[],
  cardBefore: string | null,
): void {
  const current = cardToolUseId(sessionId);
  if (current !== cardBefore) return;
  if (current && !controls.some((c) => c.tool_use_id === current)) {
    clearCard(sessionId);
  }
  for (const control of controls) {
    if (control.tool_use_id === cardToolUseId(sessionId)) continue;
    applyAgentPermissionPrompt({
      chat_session_id: sessionId,
      tool_use_id: control.tool_use_id,
      tool_name: control.tool_name,
      input: control.input,
    });
  }
}

/**
 * Recover approval prompts for a session on a paired server. Prompts are
 * delivered as live events, so any raised before this window connected, or
 * while events were being lost, only exist in the server's snapshot.
 */
export async function hydrateRemotePendingControls(
  connectionId: string,
  sessionId: string,
): Promise<void> {
  const cardBefore = cardToolUseId(sessionId);
  const snapshot = (await sendRemoteCommand(connectionId, "get_chat_snapshot", {
    chat_session_id: sessionId,
    limit: 1,
  })) as { pending_controls?: PendingAgentControl[] } | null;
  reconcilePendingControls(
    sessionId,
    snapshot?.pending_controls ?? [],
    cardBefore,
  );
}

/** `hydrateRemotePendingControls` for every loaded session of a connection. */
export function hydrateConnectionPendingControls(connectionId: string): void {
  const state = useAppStore.getState();
  const workspaceIds = state.workspaces
    .filter((ws) => ws.remote_connection_id === connectionId)
    .map((ws) => ws.id);
  for (const wsId of workspaceIds) {
    for (const session of state.sessionsByWorkspace[wsId] ?? []) {
      hydrateRemotePendingControls(connectionId, session.id).catch((e) =>
        console.error("Failed to recover pending approvals:", e),
      );
    }
  }
}
