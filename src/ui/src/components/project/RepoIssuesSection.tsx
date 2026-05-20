import { memo, useMemo, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { openUrl } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { useRepoOpenIssues } from "../../hooks/useRepoOpenIssues";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { useModelRegistry } from "../chat/useModelRegistry";
import { useWorkspaceScmLink } from "../../hooks/useWorkspaceScmLink";
import type { Issue, IssueLabel } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";
import { formatTimeAgo } from "./timeAgo";
import { WorkspaceLinkBadge } from "./WorkspaceLinkBadge";
import {
  buildModelSubmenuItems,
  sendToNewWorkspace,
} from "./sendToNewWorkspace";

/// Maximum visible label chips per row before collapsing the rest into a
/// "+N" overflow indicator. Two preserves room for the title + comment
/// count + age on the right side without truncating the title aggressively.
const MAX_LABELS_VISIBLE = 2;

/// Default visible-row cap. Beyond this the user clicks "Show all (N)" to
/// expand to ALL_VISIBLE_LIMIT; beyond that we link out to the provider.
const DEFAULT_VISIBLE = 10;
const ALL_VISIBLE_LIMIT = 50;

export interface RepoIssuesSectionProps {
  repoId: string;
}

export const RepoIssuesSection = memo(function RepoIssuesSection({
  repoId,
}: RepoIssuesSectionProps) {
  // Sections render collapsed by default. The header still surfaces the
  // open-count badge so the project view tells you what's outstanding
  // upstream without forcing two long lists into the layout above the
  // workspaces grid. User clicks the chevron to expand.
  const [open, setOpen] = useState(false);
  const { payload, loading, refresh } = useRepoOpenIssues(repoId);
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const issues = useMemo(() => payload?.issues ?? [], [payload?.issues]);
  const visible = useMemo(() => {
    if (showAll) return issues.slice(0, ALL_VISIBLE_LIMIT);
    return issues.slice(0, DEFAULT_VISIBLE);
  }, [issues, showAll]);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      addToast("URL copied");
    } catch {
      addToast("Failed to copy URL");
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
          <CircleDot size={12} className={dashStyles.archivedIcon} aria-hidden />
          <span className={dashStyles.workspacesTitle}>Issues</span>
          {issues.length > 0 && (
            <span className={dashStyles.headerCount}>{issues.length} open</span>
          )}
        </button>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh issues"
          >
            <RefreshCw
              size={12}
              className={loading ? styles.refreshSpinning : undefined}
            />
          </button>
        </div>
      </div>

      {open && (
        <RepoIssuesBody
          repoId={repoId}
          payload={payload}
          loading={loading}
          visible={visible}
          totalCount={issues.length}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
          onRetry={() => void refresh()}
          onOpen={(url) => {
            void openUrl(url);
          }}
          onCopyUrl={(url) => void handleCopyUrl(url)}
        />
      )}
    </div>
  );
});

interface RepoIssuesBodyProps {
  repoId: string;
  payload: ReturnType<typeof useRepoOpenIssues>["payload"];
  loading: boolean;
  visible: Issue[];
  totalCount: number;
  showAll: boolean;
  onShowAll: () => void;
  onRetry: () => void;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
}

function RepoIssuesBody({
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
}: RepoIssuesBodyProps) {
  if (loading && !payload) {
    return <SkeletonList />;
  }
  if (payload?.unsupported) {
    return (
      <div className={styles.muted}>
        Issues are not supported by this provider.
      </div>
    );
  }
  // Backend preserves prior cached rows + sets `error` on transient
  // provider failures so the UI can keep the user oriented. Render the
  // cached rows when present and surface the error non-destructively
  // above the list; only replace the list with an error banner when we
  // have *nothing* cached to fall back to.
  const hasCachedRows = totalCount > 0;
  if (payload?.error && !hasCachedRows) {
    return (
      <div className={styles.error}>
        <span>Could not load issues.</span>
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
    return <div className={styles.muted}>No open issues.</div>;
  }

  return (
    <>
      {payload?.error && (
        <div className={styles.errorBanner}>
          <span>Could not refresh issues — showing cached results.</span>
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
        {visible.map((issue) => (
          <IssueRow
            key={issue.number}
            repoId={repoId}
            issue={issue}
            onOpen={onOpen}
            onCopyUrl={onCopyUrl}
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

interface IssueRowProps {
  repoId: string;
  issue: Issue;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
}

function IssueRow({ repoId, issue, onOpen, onCopyUrl }: IssueRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const registry = useModelRegistry();
  const addToast = useAppStore((s) => s.addToast);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const linked = useWorkspaceScmLink(repoId, "issue", issue.number);
  const visibleLabels = issue.labels.slice(0, MAX_LABELS_VISIBLE);
  const overflow = Math.max(0, issue.labels.length - visibleLabels.length);

  const items: ContextMenuItem[] = [
    { label: "Open in browser", onSelect: () => onOpen(issue.url) },
    { label: "Copy URL", onSelect: () => onCopyUrl(issue.url) },
    { type: "separator" },
    // When a workspace is already on this issue, offer a jump to it
    // *above* — not instead of — "Send to new workspace": a second
    // workspace on the same issue is still one deliberate click away.
    ...(linked
      ? ([
          {
            label: `Go to workspace “${linked.workspaceName}”`,
            onSelect: () => selectWorkspace(linked.workspaceId),
          },
        ] satisfies ContextMenuItem[])
      : []),
    {
      type: "submenu",
      label: "Send to new workspace",
      children: buildModelSubmenuItems(registry, async (model) => {
        try {
          await sendToNewWorkspace({
            repoId,
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
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
        onClick={() => onOpen(issue.url)}
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
            onOpen(issue.url);
          }
        }}
      >
        <span className={styles.rowNumber}>#{issue.number}</span>
        <span className={styles.rowTitle} title={issue.title}>
          {issue.title}
        </span>
        {visibleLabels.length > 0 && (
          <span className={styles.labels}>
            {visibleLabels.map((lbl) => (
              <LabelChip key={lbl.name} label={lbl} />
            ))}
            {overflow > 0 && (
              <span className={styles.labelMore}>+{overflow}</span>
            )}
          </span>
        )}
        {linked && <WorkspaceLinkBadge link={linked} />}
        <span className={styles.rowMeta}>
          {issue.comment_count > 0 && (
            <span className={styles.rowCommentCount}>
              <MessageSquare size={11} aria-hidden />
              {issue.comment_count}
            </span>
          )}
          <span className={styles.rowAge}>{formatTimeAgo(issue.updated_at)}</span>
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

interface LabelChipProps {
  label: IssueLabel;
}

function LabelChip({ label }: LabelChipProps) {
  // GitHub / GitLab label colors are arbitrary maintainer-chosen hex
  // values — content, not a design token — so they can't be tokenized.
  // Hand the one raw value to CSS as a `--label-color` custom property
  // and let the stylesheet compose the tinted background / border via
  // `color-mix` (keeps the alpha math out of the component).
  const style = label.color
    ? ({ "--label-color": `#${label.color}` } as CSSProperties)
    : undefined;
  return (
    <span
      className={`${styles.label}${label.color ? ` ${styles.labelColored}` : ""}`}
      style={style}
      title={label.name}
    >
      {label.name}
    </span>
  );
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

