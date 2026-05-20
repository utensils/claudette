import type { StateCreator } from "zustand";
import type {
  PullRequestScope,
  RepoIssuesPayload,
  RepoPullRequestsPayload,
  ScmDetail,
  ScmSummary,
  WorkspaceScmLink,
} from "../../types/plugin";
import type { AppState } from "../useAppStore";

export interface ScmSlice {
  scmSummary: Record<string, ScmSummary>;
  /** Full PR+CI detail keyed by workspace_id. Populated at boot from SQLite
   *  cache and kept fresh by background polling events — so workspace switches
   *  can show instant state without a network round-trip. */
  scmDetails: Record<string, ScmDetail>;
  scmDetailLoading: boolean;
  setScmSummary: (wsId: string, summary: ScmSummary) => void;
  setScmDetail: (detail: ScmDetail) => void;
  setScmDetailLoading: (loading: boolean) => void;

  // --- Project-view repo-wide lists ---

  /** Open issues per repo_id. Powers the project-view Issues section.
   *  Hydrated lazily by `useRepoOpenIssues`; survives repo switches so a
   *  return to a previously-viewed repo paints instantly. */
  repoIssuesByRepoId: Record<string, RepoIssuesPayload>;
  /** Open PRs per repo_id per scope. Powers the project-view PR section's
   *  scope tabs (open / mine / review_requested). */
  repoPullRequestsByRepoId: Record<
    string,
    Partial<Record<PullRequestScope, RepoPullRequestsPayload>>
  >;
  setRepoIssues: (repoId: string, payload: RepoIssuesPayload) => void;
  setRepoPullRequests: (
    repoId: string,
    scope: PullRequestScope,
    payload: RepoPullRequestsPayload,
  ) => void;
  /** Drop both issues and PR caches for a repo. Called after a manual
   *  refresh clears the backend cache so a stale frontend store doesn't
   *  beat the next fetch. */
  clearRepoScmLists: (repoId: string) => void;

  // --- Workspace <-> SCM item links ---

  /** Issue/PR associations keyed by `workspace_id`. Hydrated at boot from
   *  `load_initial_data` and appended to when `sendToNewWorkspace`
   *  succeeds. Powers the project-view "in progress" badge and the
   *  workspace-side breadcrumb. Rows for archived/deleted workspaces are
   *  filtered out at read time (see `resolveWorkspaceLink`) rather than
   *  evicted here, so an archive -> restore round-trip keeps the link. */
  workspaceScmLinks: Record<string, WorkspaceScmLink>;
  /** Replace the boot snapshot of workspace -> SCM links. */
  hydrateWorkspaceScmLinks: (links: WorkspaceScmLink[]) => void;
  /** Record a single workspace -> SCM link (after `sendToNewWorkspace`). */
  setWorkspaceScmLink: (link: WorkspaceScmLink) => void;
}

export const createScmSlice: StateCreator<AppState, [], [], ScmSlice> = (
  set,
) => ({
  scmSummary: {},
  scmDetails: {},
  scmDetailLoading: false,
  setScmSummary: (wsId, summary) =>
    set((s) => ({
      scmSummary: { ...s.scmSummary, [wsId]: summary },
    })),
  setScmDetail: (detail) =>
    set((s) => ({
      scmDetails: { ...s.scmDetails, [detail.workspace_id]: detail },
    })),
  setScmDetailLoading: (loading) => set({ scmDetailLoading: loading }),

  repoIssuesByRepoId: {},
  repoPullRequestsByRepoId: {},
  setRepoIssues: (repoId, payload) =>
    set((s) => ({
      repoIssuesByRepoId: { ...s.repoIssuesByRepoId, [repoId]: payload },
    })),
  setRepoPullRequests: (repoId, scope, payload) =>
    set((s) => ({
      repoPullRequestsByRepoId: {
        ...s.repoPullRequestsByRepoId,
        [repoId]: {
          ...(s.repoPullRequestsByRepoId[repoId] ?? {}),
          [scope]: payload,
        },
      },
    })),
  clearRepoScmLists: (repoId) =>
    set((s) => {
      const nextIssues = { ...s.repoIssuesByRepoId };
      delete nextIssues[repoId];
      const nextPrs = { ...s.repoPullRequestsByRepoId };
      delete nextPrs[repoId];
      return {
        repoIssuesByRepoId: nextIssues,
        repoPullRequestsByRepoId: nextPrs,
      };
    }),

  workspaceScmLinks: {},
  hydrateWorkspaceScmLinks: (links) =>
    set(() => ({
      workspaceScmLinks: Object.fromEntries(
        links.map((l) => [l.workspace_id, l]),
      ),
    })),
  setWorkspaceScmLink: (link) =>
    set((s) => ({
      workspaceScmLinks: {
        ...s.workspaceScmLinks,
        [link.workspace_id]: link,
      },
    })),
});
