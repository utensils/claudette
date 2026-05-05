export type WorkspaceStatus = "Active" | "Archived";

export type AgentStatus =
  | "Running"
  | "Idle"
  | "IdleWithBackground"
  | "Stopped"
  | "Compacting"
  | { Error: string };

export interface Workspace {
  id: string;
  repository_id: string;
  name: string;
  branch_name: string;
  worktree_path: string | null;
  status: WorkspaceStatus;
  agent_status: AgentStatus;
  status_line: string;
  created_at: string;
  /** Non-null when this workspace belongs to a remote connection. */
  remote_connection_id: string | null;
}
