import { memo, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { useRepoOpenPullRequests } from "../../hooks/useRepoOpenPullRequests";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { useModelRegistry } from "../chat/useModelRegistry";
import { useWorkspaceScmLink } from "../../hooks/useWorkspaceScmLink";
import type { PullRequest, PullRequestScope } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";
import { WorkspaceLinkBadge } from "./WorkspaceLinkBadge";
import { RepoListGroup } from "./RepoListGroup";
import { partitionByWorkspaceLink } from "./workspaceScmLink";
import {
  buildModelSubmenuItems,
  sendToNewWorkspace,
} from "./sendToNewWorkspace";

const DEFAULT_VISIBLE = 10;
const ALL_VISIBLE_LIMIT = 50;

const SCOPES = [
  { value: "open", labelKey: "repo_scope_open" },
  { value: "mine", labelKey: "repo_scope_mine" },
  { value: "review_requested", labelKey: "repo_scope_review" },
] as const satisfies readonly { value: PullRequestScope; labelKey: string }[];

export interface RepoPullRequestsSectionProps {
  repoId: string;
}

export const RepoPullRequestsSection = memo(function RepoPullRequestsSection({
  repoId,
}: RepoPullRequestsSectionProps) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<PullRequestScope>("open");
  const { payload, isStale, loading, refresh } = useRepoOpenPullRequests(
    repoId,
    scope,
  );
  // Collapsed by default — header surfaces the count, clicking the
  // chevron expands. Symmetrical with RepoIssuesSection.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const prs = useMemo(
    () => payload?.pull_requests ?? [],
    [payload?.pull_requests],
  );
  // Dispatched PRs (ones that already have a workspace) get their own
  // "In progress" group above the rest (issue #898). The row cap
  // applies only to `rest`.
  const workspaceScmLinks = useAppStore((s) => s.workspaceScmLinks);
  const workspaces = useAppStore((s) => s.workspaces);
  const { inProgress, rest } = useMemo(
    () =>
      partitionByWorkspaceLink(
        prs,
        { repoId, kind: "pr" },
        workspaceScmLinks,
        workspaces,
      ),
    [prs, repoId, workspaceScmLinks, workspaces],
  );
  const visibleRest = useMemo(() => {
    if (showAll) return rest.slice(0, ALL_VISIBLE_LIMIT);
    return rest.slice(0, DEFAULT_VISIBLE);
  }, [rest, showAll]);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      addToast(t("repo_url_copied"));
    } catch {
      addToast(t("repo_url_copy_failed"));
    }
  };

  const handleCreateWorkspaceInRepo = async (pr: PullRequest) => {
    // The workspace is created on the repo's default base — the
    // create_workspace Tauri command doesn't yet accept a branch arg, so
    // we can't pre-check out pr.branch here (tracked as an issue-890
    // follow-up). Surface the PR branch in the toast so the user knows
    // the manual `git checkout` is on them.
    try {
      const created = await createWorkspaceOrchestrated(repoId);
      if (created) {
        addToast(t("repo_pr_workspace_ready", { branch: pr.branch }));
      }
    } catch (e) {
      addToast(
        t("repo_create_failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  return (
    <div className={dashStyles.workspacesSection}>
      <div className={dashStyles.archivedHeaderRow}>
        <button
          type="button"
          className={dashStyles.workspacesHeader}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <GitPullRequest size={12} className={dashStyles.archivedIcon} aria-hidden />
          <span className={dashStyles.workspacesTitle}>{t("repo_prs_title")}</span>
          {prs.length > 0 && (
            // Bare count, no " open" suffix: the count tracks whatever
            // scope is active (Open / Mine / Review), and "open" was
            // misleading on the Mine/Review tabs where the number is
            // scope-filtered. The toggle next to it disambiguates.
            <span className={dashStyles.headerCount}>{prs.length}</span>
          )}
        </button>
        <div className={styles.headerRight}>
          <div className={styles.scopeTabs} role="tablist">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={scope === s.value}
                className={`${styles.scopeTab} ${scope === s.value ? styles.scopeTabActive : ""}`}
                onClick={() => {
                  setScope(s.value);
                  setShowAll(false);
                }}
              >
                {t(s.labelKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={() => void refresh()}
            disabled={loading}
            title={t("repo_refresh")}
            aria-label={t("repo_prs_refresh")}
          >
            <RefreshCw
              size={12}
              className={loading ? styles.refreshSpinning : undefined}
            />
          </button>
        </div>
      </div>

      {open && (
        <RepoPullRequestsBody
          repoId={repoId}
          payload={payload}
          isStale={isStale}
          inProgress={inProgress}
          visibleRest={visibleRest}
          restTotal={rest.length}
          totalCount={prs.length}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
          onRetry={() => void refresh()}
          onOpen={(url) => {
            void openUrl(url);
          }}
          onCopyUrl={(url) => void handleCopyUrl(url)}
          onCreateWorkspaceForBranch={(pr) =>
            void handleCreateWorkspaceInRepo(pr)
          }
        />
      )}
    </div>
  );
});

interface RepoPullRequestsBodyProps {
  repoId: string;
  payload: ReturnType<typeof useRepoOpenPullRequests>["payload"];
  /// True when `payload` is the previous scope's data (stale-while-
  /// revalidate). The list dims while real data is in flight.
  isStale: boolean;
  /// PRs that already have a workspace — rendered in their own group.
  inProgress: PullRequest[];
  /// The remaining PRs, already capped to the visible-row limit.
  visibleRest: PullRequest[];
  /// Total count of `rest` before the cap — drives the "Show all" row.
  restTotal: number;
  /// Total count of all open PRs — drives the empty/error branches.
  totalCount: number;
  showAll: boolean;
  onShowAll: () => void;
  onRetry: () => void;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
  onCreateWorkspaceForBranch: (pr: PullRequest) => void;
}

function RepoPullRequestsBody({
  repoId,
  payload,
  isStale,
  inProgress,
  visibleRest,
  restTotal,
  totalCount,
  showAll,
  onShowAll,
  onRetry,
  onOpen,
  onCopyUrl,
  onCreateWorkspaceForBranch,
}: RepoPullRequestsBodyProps) {
  const { t } = useTranslation();
  // Render the skeleton whenever we don't yet have a payload for this
  // (repo, scope) pair — see RepoIssuesSection's RepoIssuesBody for the
  // rationale. Switching scope tabs selects a store slot that may be
  // `undefined` until the fetch lands; relying on `loading` alone would
  // briefly flash the empty state.
  if (!payload) {
    return <SkeletonList />;
  }
  if (payload?.unsupported) {
    return (
      <div className={styles.muted}>
        {t("repo_prs_unsupported")}
      </div>
    );
  }
  // See RepoIssuesSection's RepoIssuesBody for the rationale — the
  // backend keeps prior cached rows in `payload` on transient failures,
  // and replacing the list with an error banner hides that state.
  const hasCachedRows = totalCount > 0;
  if (payload?.error && !hasCachedRows) {
    return (
      <div className={styles.error}>
        <span>{t("repo_prs_load_failed")}</span>
        <button
          type="button"
          className={styles.retryButton}
          onClick={onRetry}
        >
          {t("repo_retry")}
        </button>
      </div>
    );
  }
  if (!hasCachedRows) {
    return <div className={styles.muted}>{t("repo_prs_none_open")}</div>;
  }

  const renderRow = (pr: PullRequest) => (
    <PullRequestRow
      key={pr.number}
      repoId={repoId}
      pr={pr}
      onOpen={onOpen}
      onCopyUrl={onCopyUrl}
      onCreateWorkspaceForBranch={onCreateWorkspaceForBranch}
    />
  );
  const showAllRow = !showAll && restTotal > visibleRest.length && (
    <li>
      <button type="button" className={styles.retryButton} onClick={onShowAll}>
        {t("repo_show_all", { count: restTotal })}
      </button>
    </li>
  );

  // Stale-while-revalidate: dim the rows while the new-scope fetch is
  // in flight. See RepoIssuesSection's RepoIssuesBody for the
  // rationale.
  const staleClass = isStale ? styles.stale : "";

  return (
    <div className={staleClass} aria-busy={isStale || undefined}>
      {payload?.error && (
        <div className={styles.errorBanner}>
          <span>{t("repo_prs_refresh_failed")}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={onRetry}
          >
            {t("repo_retry")}
          </button>
        </div>
      )}
      {inProgress.length > 0 ? (
        // Dispatched PRs get their own group above the rest; flat list
        // when nothing is dispatched keeps the common case unchanged.
        <>
          <RepoListGroup label={t("repo_group_in_progress")} count={inProgress.length} accent>
            <ul className={styles.list}>{inProgress.map(renderRow)}</ul>
          </RepoListGroup>
          <RepoListGroup label={t("repo_group_open")} count={restTotal}>
            <ul className={styles.list}>
              {visibleRest.map(renderRow)}
              {showAllRow}
            </ul>
          </RepoListGroup>
        </>
      ) : (
        <ul className={styles.list}>
          {visibleRest.map(renderRow)}
          {showAllRow}
        </ul>
      )}
    </div>
  );
}

interface PullRequestRowProps {
  repoId: string;
  pr: PullRequest;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
  onCreateWorkspaceForBranch: (pr: PullRequest) => void;
}

function PullRequestRow({
  repoId,
  pr,
  onOpen,
  onCopyUrl,
  onCreateWorkspaceForBranch,
}: PullRequestRowProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const registry = useModelRegistry();
  const addToast = useAppStore((s) => s.addToast);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const linked = useWorkspaceScmLink(repoId, "pr", pr.number);

  const items: ContextMenuItem[] = [
    { label: t("repo_open_in_browser"), onSelect: () => onOpen(pr.url) },
    { label: t("repo_copy_url"), onSelect: () => onCopyUrl(pr.url) },
    {
      // Honest label: this creates a workspace on the repo's default
      // branch, NOT the PR head — see handleCreateWorkspaceInRepo in
      // the parent component for the follow-up tracker.
      label: t("repo_pr_new_workspace_in_repo"),
      onSelect: () => onCreateWorkspaceForBranch(pr),
    },
    { type: "separator" },
    // Jump to an existing workspace for this PR, kept *alongside* the
    // "Send to new workspace" submenu rather than replacing it.
    ...(linked
      ? ([
          {
            label: t("repo_go_to_workspace", { name: linked.workspaceName }),
            onSelect: () => selectWorkspace(linked.workspaceId),
          },
        ] satisfies ContextMenuItem[])
      : []),
    {
      type: "submenu",
      label: t("repo_send_to_new_workspace"),
      children: buildModelSubmenuItems(registry, async (model) => {
        try {
          await sendToNewWorkspace({
            repoId,
            kind: "pr",
            number: pr.number,
            title: pr.title,
            url: pr.url,
            branch: pr.branch,
            modelId: model.id,
            providerId: model.providerId,
          });
        } catch (e) {
          addToast(
            t("repo_send_failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }),
    },
  ];

  return (
    <li>
      <div
        className={styles.row}
        onClick={() => onOpen(pr.url)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          // A `role="button"` element must activate on Space as well as
          // Enter; preventDefault stops Space from scrolling the page.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(pr.url);
          }
        }}
      >
        <span className={styles.rowNumber}>#{pr.number}</span>
        <span className={styles.rowIcon}>
          <PrStateIcon pr={pr} />
        </span>
        <span className={styles.rowTitle} title={pr.title}>
          {pr.title}
        </span>
        <span className={styles.rowBranch} title={`${pr.base} ← ${pr.branch}`}>
          {pr.base} ← {pr.branch}
        </span>
        {linked && <WorkspaceLinkBadge link={linked} />}
        <span className={styles.rowMeta}>
          {pr.author && <span>{pr.author}</span>}
        </span>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </li>
  );
}

function PrStateIcon({ pr }: { pr: PullRequest }) {
  // Mirrors the precedence in `resolveScmPrIcon`:
  //   merged → GitMerge (badge-plan)
  //   closed → GitPullRequestClosed (status-stopped)
  //   draft  → GitPullRequestDraft (text-dim)
  //   open   → GitPullRequest, tinted by CI rollup state
  const Icon =
    pr.state === "merged"
      ? GitMerge
      : pr.state === "closed"
      ? GitPullRequestClosed
      : pr.state === "draft"
      ? GitPullRequestDraft
      : GitPullRequest;
  const color =
    pr.state === "merged"
      ? "var(--badge-plan)"
      : pr.state === "closed"
      ? "var(--status-stopped)"
      : pr.state === "draft"
      ? "var(--text-dim)"
      : pr.ci_status === "failure"
      ? "var(--status-stopped)"
      : pr.ci_status === "pending"
      ? "var(--badge-ask)"
      : "var(--badge-done)";
  return <Icon size={12} style={{ color }} aria-hidden />;
}

function SkeletonList() {
  return (
    <ul className={styles.list}>
      <li className={styles.skeletonRow} />
      <li className={styles.skeletonRow} />
      <li className={styles.skeletonRow} />
    </ul>
  );
}

