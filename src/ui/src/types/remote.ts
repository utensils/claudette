export interface RemoteConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  session_token: string | null;
  cert_fingerprint: string | null;
  auto_connect: boolean;
  created_at: string;
  /** This local user's identity as seen by the remote server. Derived from
   *  the session token; used by the UI to detect "this message is mine"
   *  when rendering chat in collaborative sessions. Optional because the
   *  Rust side `#[serde(skip_serializing_if = "Option::is_none")]`s it. */
  participant_id?: string | null;
}

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  cert_fingerprint_prefix: string;
  is_paired: boolean;
}

export interface PairResult {
  connection: RemoteConnectionInfo;
  server_name: string;
  initial_data: RemoteInitialData | null;
  participant_id?: string | null;
}

export interface RemoteInitialData {
  repositories: import("./repository").Repository[];
  workspaces: import("./workspace").Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: import("./chat").ChatMessage[];
}
