// Shared TS types mirroring the Rust-side serde shapes. Kept tiny — only
// the fields the mobile UI actually renders. Bigger types (workspaces,
// chat messages, agent events) land in Phase 6+ when we start consuming
// them.

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
