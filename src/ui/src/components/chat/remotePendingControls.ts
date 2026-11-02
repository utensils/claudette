import { sendRemoteCommand } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { applyAgentPermissionPrompt } from "../../hooks/useAgentStream";
import type { ChatMessage, ChatSession, SessionAgentStatus } from "../../types";
import {
  clearPromptStartTimeIfWorkspaceIdle,
  syncWorkspaceTurnStatus,
} from "./chatTurnLifecycle";

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

/** The parts of a `get_chat_snapshot` response a resync reads. */
interface ChatSnapshotResponse {
  session?: { agent_status: SessionAgentStatus };
  pending_controls?: PendingAgentControl[];
}

function findSession(sessionId: string): ChatSession | undefined {
  for (const sessions of Object.values(useAppStore.getState().sessionsByWorkspace)) {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) return session;
  }
  return undefined;
}

/** Everything a live event for the session would replace. Store updates are
 *  immutable, so an unchanged marker means no live event landed. */
function liveMarker(sessionId: string): unknown[] {
  const s = useAppStore.getState();
  return [
    findSession(sessionId)?.agent_status,
    s.chatMessages[sessionId],
    s.streamingContent[sessionId],
    s.toolActivities[sessionId],
  ];
}

/**
 * Recover a paired server's session after this window missed its events
 * (it wasn't connected, or events were dropped): approval prompts, the
 * session's run status, and, when `reloadHistory` is set or the status
 * changed, its loaded transcript. A turn that ended while events were lost
 * is closed out so the composer and queue stop treating it as running.
 *
 * Status and history are left alone if a live event touched the session
 * while the snapshot was in flight, since that event is newer.
 */
export async function hydrateRemotePendingControls(
  connectionId: string,
  sessionId: string,
  { reloadHistory = false }: { reloadHistory?: boolean } = {},
): Promise<void> {
  const cardBefore = cardToolUseId(sessionId);
  const before = liveMarker(sessionId);
  const snapshot = (await sendRemoteCommand(connectionId, "get_chat_snapshot", {
    chat_session_id: sessionId,
    limit: 1,
  })) as ChatSnapshotResponse | null;
  reconcilePendingControls(
    sessionId,
    snapshot?.pending_controls ?? [],
    cardBefore,
  );

  const serverStatus = snapshot?.session?.agent_status;
  const localStatus = before[0] as SessionAgentStatus | undefined;
  if (!serverStatus || !localStatus) return;
  const messagesLoaded = before[1] !== undefined;
  const statusChanged = localStatus !== serverStatus;
  const history =
    messagesLoaded && (reloadHistory || statusChanged)
      ? ((await sendRemoteCommand(connectionId, "load_chat_history", {
          chat_session_id: sessionId,
        })) as { messages?: ChatMessage[] } | ChatMessage[] | null)
      : null;

  const current = liveMarker(sessionId);
  if (current.some((value, i) => value !== before[i])) return;
  const store = useAppStore.getState();
  if (localStatus === "Running" && serverStatus !== "Running") {
    // The turn's result and exit events were lost: close it out the way
    // the stream would have, keeping its tool calls as a completed turn.
    store.finalizeTurn(sessionId, 0);
    store.setStreamingContent(sessionId, "");
    store.clearStreamingThinking(sessionId);
  }
  if (statusChanged) {
    store.updateChatSession(sessionId, { agent_status: serverStatus });
    const workspaceId = findSession(sessionId)?.workspace_id;
    if (workspaceId) {
      syncWorkspaceTurnStatus(workspaceId);
      clearPromptStartTimeIfWorkspaceIdle(workspaceId);
    }
  }
  if (history) {
    const messages = Array.isArray(history) ? history : (history.messages ?? []);
    // Same filter the history loader applies to a remote transcript.
    store.setChatMessages(
      sessionId,
      messages.filter(
        (m) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking,
      ),
    );
  }
}

/** Resync every loaded session of a connection, reloading transcripts that
 *  are open (events for them may have been lost). */
export function hydrateConnectionPendingControls(connectionId: string): void {
  const state = useAppStore.getState();
  const workspaceIds = state.workspaces
    .filter((ws) => ws.remote_connection_id === connectionId)
    .map((ws) => ws.id);
  for (const wsId of workspaceIds) {
    for (const session of state.sessionsByWorkspace[wsId] ?? []) {
      hydrateRemotePendingControls(connectionId, session.id, {
        reloadHistory: true,
      }).catch((e) => console.error("Failed to resync remote session:", e));
    }
  }
}
