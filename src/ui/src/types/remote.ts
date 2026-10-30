export interface RemoteConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  session_token: string | null;
  cert_fingerprint: string | null;
  auto_connect: boolean;
  created_at: string;
}

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  cert_fingerprint_prefix: string;
  is_paired: boolean;
}

/** Outcome of removing a saved server. */
export interface RemoveResult {
  /** The server confirmed it revoked this device's session. */
  revoked: boolean;
  /** Why revocation failed, when it did. */
  revoke_error: string | null;
}

export interface PairResult {
  connection: RemoteConnectionInfo;
  server_name: string;
  initial_data: RemoteInitialData | null;
}

export interface RemoteInitialData {
  repositories: import("./repository").Repository[];
  workspaces: import("./workspace").Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: import("./chat").ChatMessage[];
}
