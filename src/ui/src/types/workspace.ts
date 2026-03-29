export type WorkspaceStatus = "Active" | "Archived";

export type AgentStatus =
  | "Running"
  | "Idle"
  | "Stopped"
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
}
