import { useAppStore } from "../stores/useAppStore";
import type { AppState } from "../stores/useAppStore";

/// Returns the local user's participant id for the given workspace, or `null`
/// if the workspace doesn't exist (or its remote connection hasn't yet
/// supplied a `participant_id`).
///
/// - For local (host-owned) workspaces, returns the `"host"` sentinel — this
///   matches the value the Tauri-side bridge stamps on outgoing messages
///   when a room exists for the session.
/// - For paired remote workspaces, returns the `participant_id` the remote
///   server issued during pairing. The remote knows itself by *that* id, not
///   by `"host"`, so any UI logic that needs to ask "is this me?" must
///   compare against this value rather than against the literal `"host"`.
///
/// Both the React hook (`useSelfParticipantId`) and the plain `getSelf*`
/// helper share this body so render-context callers and event-listener
/// callers (e.g. `useAgentStream`'s `chat-message-added` handler, which
/// runs in a Tauri-event callback rather than a render) get the same
/// answer. Keeping the derivation in one place is what keeps the
/// `=== "host"` mistake — see commit `0b077a8` — from recurring.
export function selfParticipantIdForWorkspace(
  state: AppState,
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  const w = state.workspaces.find((ws) => ws.id === workspaceId);
  if (!w) return null;
  if (!w.remote_connection_id) return "host";
  return (
    state.remoteConnections.find((c) => c.id === w.remote_connection_id)
      ?.participant_id ?? null
  );
}

export function useSelfParticipantId(workspaceId: string | null): string | null {
  return useAppStore((s) => selfParticipantIdForWorkspace(s, workspaceId));
}
