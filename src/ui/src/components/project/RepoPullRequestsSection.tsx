import { memo, useEffect, useMemo, useState } from "react";
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
import type { PullRequest, PullRequestScope } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";

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
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const autoCollapsedRef = useState(false);
  useEffect(() => {
    if (
      !autoCollapsedRef[0] &&
      scope === "open" &&
      payload &&
      !payload.unsupported &&
      !payload.error &&
      payload.pull_requests.length === 0
    ) {
      setOpen(false);
      autoCollapsedRef[1](true);
    }
    // Re-evaluation only when the open-scope count first lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, payload?.pull_requests.length, payload?.unsupported, payload?.error]);

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

  const handleCreateWorkspaceForBranch = async (pr: PullRequest) => {
    // TODO(#890 follow-up): once `create_workspace` accepts a base
    // branch arg, plumb pr.branch through so the new worktree is
    // checked out at that PR's head. For v1 we create a workspace
    // on the repo's default base and surface the PR branch via a
    // toast so the user knows the follow-up `git checkout` is on
    // them. Implementing the full pre-fill needs a backend signature
    // change and lives in its own ticket.
    try {
      const created = await createWorkspaceOrchestrated(repoId);
      if (created) {
        addToast(`Workspace ready. PR branch: ${pr.branch}`);
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
            void handleCreateWorkspaceForBranch(pr)
          }
        />
      )}
    </div>
  );
});

interface RepoPullRequestsBodyProps {
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
  if (payload?.error) {
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
  if (totalCount === 0) {
    return <div className={styles.muted}>No open pull requests.</div>;
  }

  return (
    <ul className={styles.list}>
      {visible.map((pr) => (
        <PullRequestRow
          key={pr.number}
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
  );
}

interface PullRequestRowProps {
  pr: PullRequest;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
  onCreateWorkspaceForBranch: (pr: PullRequest) => void;
}

function PullRequestRow({
  pr,
  onOpen,
  onCopyUrl,
  onCreateWorkspaceForBranch,
}: PullRequestRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
          if (e.key === "Enter") onOpen(pr.url);
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
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Open in browser",
              onClick: () => onOpen(pr.url),
            },
            {
              label: "Copy URL",
              onClick: () => onCopyUrl(pr.url),
            },
            {
              label: "Create workspace for this branch",
              onClick: () => onCreateWorkspaceForBranch(pr),
            },
          ]}
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

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  items: { label: string; onClick: () => void }[];
}

function ContextMenu({ x, y, onClose, items }: ContextMenuProps) {
  useEffect(() => {
    const dismiss = () => onClose();
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [onClose]);

  return (
    <div
      className={styles.contextMenu}
      style={{ left: x, top: y }}
      role="menu"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={styles.contextMenuItem}
          onClick={(e) => {
            e.stopPropagation();
            item.onClick();
            onClose();
          }}
          role="menuitem"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
