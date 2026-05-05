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
    const wrapped = obj.workspace as Record<string, unknown>;
    if ("id" in wrapped) {
      return wrapped as unknown as Omit<Workspace, "remote_connection_id">;
    }
  }

  // Legacy shape: bare Workspace row.
  if ("id" in obj) {
    return obj as unknown as Omit<Workspace, "remote_connection_id">;
  }

  return null;
}
