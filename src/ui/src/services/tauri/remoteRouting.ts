import { sendRemoteCommand } from "./remote";

/**
 * Routes service calls for remote workspaces to the paired server.
 *
 * Remote repos / workspaces live in the same store as local ones, tagged
 * with `remote_connection_id`. Service wrappers ask this module which
 * connection (if any) owns a workspace or chat session; a non-null answer
 * means "send this over WSS" instead of invoking a local Tauri command,
 * which would fail (the local DB has no such rows) or act on the wrong
 * machine.
 *
 * The lookup is injected by the store (see `useAppStore.ts`) so services
 * don't import the store and create a module cycle.
 */
export interface RemoteRoutingResolver {
  connectionForWorkspace(workspaceId: string): string | null;
  connectionForSession(sessionId: string): string | null;
}

let resolver: RemoteRoutingResolver = {
  connectionForWorkspace: () => null,
  connectionForSession: () => null,
};

export function setRemoteRoutingResolver(next: RemoteRoutingResolver): void {
  resolver = next;
}

export function remoteConnectionForWorkspace(
  workspaceId: string,
): string | null {
  return resolver.connectionForWorkspace(workspaceId);
}

export function remoteConnectionForSession(sessionId: string): string | null {
  return resolver.connectionForSession(sessionId);
}

/**
 * Run `method` on the remote that owns the session, or `local()` when the
 * session is local. Remote params use the server's snake_case wire names.
 */
export function viaSession<T>(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  local: () => Promise<T>,
): Promise<T> {
  const connectionId = remoteConnectionForSession(sessionId);
  if (!connectionId) return local();
  return sendRemoteCommand(connectionId, method, {
    chat_session_id: sessionId,
    ...params,
  }) as Promise<T>;
}

/** Workspace-keyed counterpart of {@link viaSession}. */
export function viaWorkspace<T>(
  workspaceId: string,
  method: string,
  params: Record<string, unknown>,
  local: () => Promise<T>,
): Promise<T> {
  const connectionId = remoteConnectionForWorkspace(workspaceId);
  if (!connectionId) return local();
  return sendRemoteCommand(connectionId, method, {
    workspace_id: workspaceId,
    ...params,
  }) as Promise<T>;
}
