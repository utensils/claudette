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
  status: "pending" | "success" | "failure" | "cancelled" | "skipped";
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

export interface CiFailureLog {
  check_name: string;
  log: string;
  url: string | null;
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

/** A persisted association between an SCM item (issue or PR) and the
 *  workspace created for it via the project-view "Send to new
 *  workspace" gesture. Keyed on `workspace_id` server-side — one
 *  workspace owns at most one item. Mirrors `WorkspaceScmLinkRow` in
 *  `src/db/scm.rs`. */
export interface WorkspaceScmLink {
  workspace_id: string;
  repo_id: string;
  kind: "issue" | "pr";
  number: number;
  url: string;
  title: string;
  created_at: string;
}

export interface IssueLabel {
  name: string;
  /** Hex color without leading '#'. May be empty when the provider
   *  doesn't expose label colors. */
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  author: string | null;
  labels: IssueLabel[];
  comment_count: number;
  created_at: string;
  updated_at: string;
}

export type PullRequestScope = "open" | "mine" | "review_requested";

export interface RepoIssuesPayload {
  issues: Issue[];
  fetched_at: string;
  error: string | null;
  /** True when the resolved provider doesn't implement `list_issues`.
   *  Distinct from `error`: surface a muted "not supported" hint, not
   *  a retry-able error banner. */
  unsupported: boolean;
  provider: string | null;
}

export interface RepoPullRequestsPayload {
  pull_requests: PullRequest[];
  scope: PullRequestScope;
  fetched_at: string;
  error: string | null;
  unsupported: boolean;
  provider: string | null;
}
