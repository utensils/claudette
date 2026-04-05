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

export interface PairResult {
  connection: RemoteConnectionInfo;
  server_name: string;
}
