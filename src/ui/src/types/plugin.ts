export interface PluginInfo {
  name: string;
  display_name: string;
  version: string;
  description: string;
  operations: string[];
  cli_available: boolean;
  remote_patterns: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  url: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  ci_status: "pending" | "success" | "failure" | null;
}

export interface CiCheck {
  name: string;
  status: "pending" | "success" | "failure" | "cancelled";
  url: string | null;
  started_at: string | null;
}

export interface ScmDetail {
  workspace_id: string;
  pull_request: PullRequest | null;
  ci_checks: CiCheck[];
  provider: string | null;
  error: string | null;
}

export interface ScmSummary {
  hasPr: boolean;
  prState: PullRequest["state"] | null;
  ciState: "success" | "failure" | "pending" | null;
  lastUpdated: number;
}

export interface ScmStatusCacheRow {
  workspace_id: string;
  repo_id: string;
  branch_name: string;
  provider: string | null;
  pr_json: string | null;
  ci_json: string | null;
  error: string | null;
  fetched_at: string;
}
