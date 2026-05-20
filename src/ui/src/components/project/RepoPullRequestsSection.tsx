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
import { openUrl } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { useRepoOpenPullRequests } from "../../hooks/useRepoOpenPullRequests";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { useModelRegistry } from "../chat/useModelRegistry";
import type { PullRequest, PullRequestScope } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";
import {
  buildModelSubmenuItems,
  sendToNewWorkspace,
} from "./sendToNewWorkspace";

const DEFAULT_VISIBLE = 10;
const ALL_VISIBLE_LIMIT = 50;

const SCOPES: { value: PullRequestScope; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "mine", label: "Mine" },
  { value: "review_requested", label: "Review" },
];

export interface RepoPullRequestsSectionProps {
  repoId: string;
}

export const RepoPullRequestsSection = memo(function RepoPullRequestsSection({
  repoId,
}: RepoPullRequestsSectionProps) {
  const [scope, setScope] = useState<PullRequestScope>("open");
  const { payload, loading, refresh } = useRepoOpenPullRequests(repoId, scope);
  // Collapsed by default — header surfaces the count, clicking the
  // chevron expands. Symmetrical with RepoIssuesSection.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const prs = useMemo(
    () => payload?.pull_requests ?? [],
    [payload?.pull_requests],
  );
  const visible = useMemo(() => {
    if (showAll) return prs.slice(0, ALL_VISIBLE_LIMIT);
    return prs.slice(0, DEFAULT_VISIBLE);
  }, [prs, showAll]);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      addToast("URL copied");
    } catch {
      addToast("Failed to copy URL");
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
        addToast(`Workspace ready (default branch). PR head: ${pr.branch}`);
      }
    } catch (e) {
      addToast(
        `Failed to create workspace: ${
          e instanceof Error ? e.message : String(e)
        }`,
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
          <span className={dashStyles.workspacesTitle}>Pull Requests</span>
          {prs.length > 0 && (
            <span className={dashStyles.headerCount}>{prs.length} open</span>
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
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh pull requests"
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
          loading={loading}
          visible={visible}
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
  loading: boolean;
  visible: PullRequest[];
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
  loading,
  visible,
  totalCount,
  showAll,
  onShowAll,
  onRetry,
  onOpen,
  onCopyUrl,
  onCreateWorkspaceForBranch,
}: RepoPullRequestsBodyProps) {
  if (loading && !payload) {
    return <SkeletonList />;
  }
  if (payload?.unsupported) {
    return (
      <div className={styles.muted}>
        Pull requests are not supported by this provider.
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
        <span>Could not load pull requests.</span>
        <button
          type="button"
          className={styles.retryButton}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!hasCachedRows) {
    return <div className={styles.muted}>No open pull requests.</div>;
  }

  return (
    <>
      {payload?.error && (
        <div className={styles.errorBanner}>
          <span>Could not refresh pull requests — showing cached results.</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}
      <ul className={styles.list}>
        {visible.map((pr) => (
          <PullRequestRow
            key={pr.number}
            repoId={repoId}
            pr={pr}
            onOpen={onOpen}
            onCopyUrl={onCopyUrl}
            onCreateWorkspaceForBranch={onCreateWorkspaceForBranch}
          />
        ))}
        {!showAll && totalCount > visible.length && (
          <li>
            <button
              type="button"
              className={styles.retryButton}
              onClick={onShowAll}
            >
              Show all ({totalCount})
            </button>
          </li>
        )}
      </ul>
    </>
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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const registry = useModelRegistry();
  const addToast = useAppStore((s) => s.addToast);

  const items: ContextMenuItem[] = [
    { label: "Open in browser", onSelect: () => onOpen(pr.url) },
    { label: "Copy URL", onSelect: () => onCopyUrl(pr.url) },
    {
      // Honest label: this creates a workspace on the repo's default
      // branch, NOT the PR head — see handleCreateWorkspaceInRepo in
      // the parent component for the follow-up tracker.
      label: "New workspace in this repo",
      onSelect: () => onCreateWorkspaceForBranch(pr),
    },
    { type: "separator" },
    {
      type: "submenu",
      label: "Send to new workspace",
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
            `Failed to send to new workspace: ${
              e instanceof Error ? e.message : String(e)
            }`,
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

