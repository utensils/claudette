import type { AppState } from "../stores/useAppStore";

/**
 * Whether the workspace id is an optimistic-fork placeholder — the
 * row exists in the React store but the backend has no corresponding
 * DB record yet. Used to short-circuit any "load X for this
 * workspace" call site so the user doesn't see a "Failed to load:
 * Workspace not found" toast / banner / panel error while the fork
 * is still being snapshot/restored on the backend.
 *
 * Surfaces that have to gate on this: FilesPanel, ChatPanel's diff
 * sync, RollbackModal, the chat composer's `@file` index, and any
 * SCM/diff polling that fires off `selectedWorkspaceId`. The
 * placeholder is removed by `commitPendingFork` (success) or
 * `cancelPendingFork` (error), so once the backend resolves these
 * effects re-fire against the real workspace id.
 */
export function isPendingForkWorkspace(
  state: AppState,
  workspaceId: string | null,
): boolean {
  if (!workspaceId) return false;
  return !!state.pendingForks[workspaceId];
}

/**
 * Whether the workspace is in the middle of an env-provider resolve and
 * UI surfaces (terminal new-tab button, chat composer, etc.) should
 * block waiting for it. Shared by `TerminalPanel` and `ChatPanel` so
 * both surfaces gate identically.
 *
 * Only `"preparing"` blocks. `"idle"`, `"ready"`, `"error"`, and
 * `undefined` all let the UI through:
 *
 * - `"idle"` is the state the prep hook leaves behind when its cleanup
 *   tears down a stale closure without a successor re-firing the
 *   effect (a React StrictMode race we've seen strand workspaces with
 *   no path back to `"ready"`). The backend resolves env-providers
 *   independently on every PTY/agent spawn (`pty.rs::spawn_pty`, the
 *   agent spawn path), so blocking the UI on this stale marker
 *   accomplishes nothing except locking the user out.
 * - `undefined` simply means the hook hasn't fired yet — again, no
 *   reason to block since the subprocess spawn paths will resolve
 *   their own env on demand.
 * - `"error"` is informational; the user already saw the toast and
 *   shouldn't be prevented from working in the meantime.
 *
 * Remote workspaces always return `false` — env-provider resolution
 * runs on the remote, not locally.
 */
export function isWorkspaceEnvironmentPreparing(
  state: AppState,
  workspaceId: string | null,
): boolean {
  if (!workspaceId) return false;
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace || workspace.remote_connection_id) return false;
  return state.workspaceEnvironment[workspaceId]?.status === "preparing";
}
