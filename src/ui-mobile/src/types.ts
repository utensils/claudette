// Shared TS types mirroring the Rust-side serde shapes. Kept narrow —
// only the fields the mobile UI actually renders.

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  session_token: string;
  fingerprint: string;
  created_at: string;
}

export interface PairResult {
  connection: SavedConnection;
}

export interface VersionInfo {
  version: string;
  commit: string | null;
}

// ---------- Server-side wire types ----------
// These are the structurally-minimal subsets the mobile UI consumes
// of the desktop's full models in `src/model/`. Keeping them here
// (rather than re-exporting from the desktop `src/ui/`) avoids
// pulling the whole desktop types tree into the mobile bundle.

export interface Repository {
  id: string;
  name: string;
  path: string;
  base_branch?: string | null;
  default_remote?: string | null;
}

export type WorkspaceStatus = "Active" | "Archived" | "Stopped";

export interface Workspace {
  id: string;
  name: string;
  repository_id: string;
  branch_name: string;
  worktree_path?: string | null;
  status: WorkspaceStatus;
  created_at?: string;
}

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
}

export interface ChatSession {
  id: string;
  workspace_id: string;
  name?: string | null;
  archived: boolean;
  created_at: string;
}

export type ChatRole = "User" | "Assistant" | "System";

export interface ChatMessage {
  id: string;
  workspace_id: string;
  chat_session_id: string;
  role: ChatRole;
  content: string;
  thinking?: string | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
  created_at: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
}
