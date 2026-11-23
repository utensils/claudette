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
  /** Per-repository display order in the sidebar. Persisted via the
   *  `workspaces.sort_order` column; reassigned by `reorder_workspaces`. */
  sort_order: number;
  /** Values supplied at workspace-create time for the repo's declared
   *  `required_inputs`. Null when the repo had no inputs declared. */
  input_values: Record<string, string> | null;
  /** Non-null when this workspace belongs to a remote connection. */
  remote_connection_id: string | null;
}

/**
 * A workspace row as the Rust backend serializes it. The Rust
 * `claudette::model::Workspace` has no `remote_connection_id` (it is a
 * UI-only routing tag), so the key is absent from IPC payloads. Typing
 * IPC results with this alias forces every caller to stamp the field
 * before the row reaches the store; a row with it `undefined` strands
 * environment preparation (see `useWorkspaceEnvironmentPreparation`).
 */
export type BackendWorkspace = Omit<Workspace, "remote_connection_id">;
