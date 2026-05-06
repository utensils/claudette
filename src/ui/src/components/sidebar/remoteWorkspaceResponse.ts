import type { Workspace } from "../../types/workspace";

/**
 * Tolerant parser for the `create_workspace` remote-server response.
 *
 * The shared command core extraction (`claudette::ops::workspace::create`)
 * changed the server's response from a bare `Workspace` row to
 * `{workspace, default_session_id, setup_result?}` so it could carry the
 * auto-created chat session id and any setup-script output.
 *
 * Old servers may still return the bare row, so we accept both shapes.
 * Returns `null` for anything that doesn't look like a workspace, which
 * the caller surfaces as an "invalid workspace" error.
 *
 * Returns `Omit<Workspace, "remote_connection_id">` because the caller
 * stamps the connection id on locally — remote payloads never carry it.
 */
export function extractRemoteWorkspace(
  result: unknown,
): Omit<Workspace, "remote_connection_id"> | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;

  // New shape: { workspace, default_session_id, ... }
  if ("workspace" in obj && obj.workspace && typeof obj.workspace === "object") {
    const candidate = obj.workspace as Record<string, unknown>;
    if (looksLikeWorkspace(candidate)) {
      return candidate as unknown as Omit<Workspace, "remote_connection_id">;
    }
  }

  // Legacy shape: bare Workspace row.
  if (looksLikeWorkspace(obj)) {
    return obj as unknown as Omit<Workspace, "remote_connection_id">;
  }

  return null;
}

// Minimum field set the rest of the UI assumes present on a Workspace
// row. We don't validate the full type — the parser is intentionally
// tolerant of forward/back compat — but missing any of these would let
// downstream code dereference `undefined` (e.g. `ws.repository_id` in
// repo-grouped sidebar lists, `ws.created_at.localeCompare(...)` in
// the dashboard sort, `ws.sort_order` in the reorder slice, `ws.name`
// in tab labels).
function looksLikeWorkspace(o: Record<string, unknown>): boolean {
  return (
    typeof o.id === "string" &&
    typeof o.repository_id === "string" &&
    typeof o.name === "string" &&
    typeof o.branch_name === "string" &&
    typeof o.status === "string" &&
    typeof o.status_line === "string" &&
    typeof o.created_at === "string" &&
    typeof o.sort_order === "number" &&
    // `worktree_path` is `string | null`, `agent_status` is a string
    // literal union OR an `{Error: string}` object, so we allow both
    // shapes rather than requiring `typeof === "string"`.
    (o.worktree_path === null || typeof o.worktree_path === "string") &&
    (typeof o.agent_status === "string" ||
      (typeof o.agent_status === "object" && o.agent_status !== null))
  );
}
