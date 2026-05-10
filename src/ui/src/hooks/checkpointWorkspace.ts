import type { Workspace } from "../types";

export function isRemoteCheckpointWorkspace(
  workspaces: Workspace[],
  workspaceId: string,
): boolean {
  return !!workspaces.find((w) => w.id === workspaceId)?.remote_connection_id;
}
