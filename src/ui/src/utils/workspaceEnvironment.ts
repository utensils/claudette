import type { AppState } from "../stores/useAppStore";

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
