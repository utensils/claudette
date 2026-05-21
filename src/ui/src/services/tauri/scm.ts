import { invoke } from "@tauri-apps/api/core";
import type {
  IssueScope,
  PluginInfo,
  PullRequest,
  PullRequestScope,
  RepoIssuesPayload,
  RepoPullRequestsPayload,
  ScmDetail,
  WorkspaceScmLink,
} from "../../types/plugin";

export function listScmProviders(): Promise<PluginInfo[]> {
  return invoke("list_scm_providers");
}

export function getScmProvider(repoId: string): Promise<string | null> {
  return invoke("get_scm_provider", { repoId });
}

export function setScmProvider(repoId: string, pluginName: string): Promise<void> {
  return invoke("set_scm_provider", { repoId, pluginName });
}

export function loadScmDetail(workspaceId: string): Promise<ScmDetail> {
  return invoke("load_scm_detail", { workspaceId });
}

export function scmCreatePr(
  workspaceId: string,
  title: string,
  body: string,
  base: string,
  draft: boolean
): Promise<PullRequest> {
  return invoke("scm_create_pr", { workspaceId, title, body, base, draft });
}

export function scmMergePr(
  workspaceId: string,
  prNumber: number
): Promise<unknown> {
  return invoke("scm_merge_pr", { workspaceId, prNumber });
}

export function listRepoOpenIssues(
  repoId: string,
  scope: IssueScope = "open",
  limit?: number,
): Promise<RepoIssuesPayload> {
  return invoke("list_repo_open_issues", { repoId, scope, limit });
}

export function listRepoOpenPullRequests(
  repoId: string,
  scope: PullRequestScope = "open",
  limit?: number,
): Promise<RepoPullRequestsPayload> {
  return invoke("list_repo_open_pull_requests", { repoId, scope, limit });
}

export function refreshRepoScmLists(repoId: string): Promise<void> {
  return invoke("refresh_repo_scm_lists", { repoId });
}

/// Persist the association between a freshly-created workspace and the
/// issue/PR it was spun up for. Returns the saved row (with the
/// DB-assigned `created_at`). Used by `sendToNewWorkspace`.
export function createWorkspaceScmLink(args: {
  workspaceId: string;
  repoId: string;
  kind: "issue" | "pr";
  number: number;
  url: string;
  title: string;
}): Promise<WorkspaceScmLink> {
  return invoke("create_workspace_scm_link", {
    workspaceId: args.workspaceId,
    repoId: args.repoId,
    kind: args.kind,
    number: args.number,
    url: args.url,
    title: args.title,
  });
}
