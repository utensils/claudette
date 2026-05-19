import { memo, useEffect, useMemo, useState } from "react";
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
import type { Issue, IssueLabel } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";
import { formatTimeAgo } from "./timeAgo";

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
  /// Optional callback so the parent can dismiss its container when the
  /// section has nothing meaningful to render (e.g. unsupported provider
  /// AND no cached payload). Optional; the section also handles its own
  /// empty/error/unsupported display.
  hidden?: boolean;
}

export const RepoIssuesSection = memo(function RepoIssuesSection({
  repoId,
}: RepoIssuesSectionProps) {
  const { payload, loading, refresh } = useRepoOpenIssues(repoId);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  // Auto-collapse on first observation of an empty list. Subsequent
  // expansions are user-controlled.
  const autoCollapsedRef = useState(false);
  useEffect(() => {
    if (
      !autoCollapsedRef[0] &&
      payload &&
      !payload.unsupported &&
      !payload.error &&
      payload.issues.length === 0
    ) {
      setOpen(false);
      autoCollapsedRef[1](true);
    }
    // We only react when the payload becomes available; later refreshes
    // don't toggle the user's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.issues.length, payload?.unsupported, payload?.error]);

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
  if (payload?.error) {
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
  if (totalCount === 0) {
    return <div className={styles.muted}>No open issues.</div>;
  }

  return (
    <ul className={styles.list}>
      {visible.map((issue) => (
        <IssueRow
          key={issue.number}
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
  );
}

interface IssueRowProps {
  issue: Issue;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
}

function IssueRow({ issue, onOpen, onCopyUrl }: IssueRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const visibleLabels = issue.labels.slice(0, MAX_LABELS_VISIBLE);
  const overflow = Math.max(0, issue.labels.length - visibleLabels.length);

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
          if (e.key === "Enter") onOpen(issue.url);
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
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Open in browser",
              onClick: () => onOpen(issue.url),
            },
            {
              label: "Copy URL",
              onClick: () => onCopyUrl(issue.url),
            },
          ]}
        />
      )}
    </li>
  );
}

interface LabelChipProps {
  label: IssueLabel;
}

function LabelChip({ label }: LabelChipProps) {
  // Apply a tinted background derived from the label color (with low alpha
  // so dark / light themes both stay readable). Border uses a stronger
  // alpha to keep the chip visible on hover backgrounds.
  const style = label.color
    ? {
        background: `#${label.color}22`,
        borderColor: `#${label.color}66`,
        color: "var(--text-primary)" as const,
      }
    : undefined;
  return (
    <span className={styles.label} style={style} title={label.name}>
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
