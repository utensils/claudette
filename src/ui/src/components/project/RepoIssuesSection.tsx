import { memo, useMemo, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { useRepoOpenIssues } from "../../hooks/useRepoOpenIssues";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { useModelRegistry } from "../chat/useModelRegistry";
import { useWorkspaceScmLink } from "../../hooks/useWorkspaceScmLink";
import type { Issue, IssueLabel, IssueScope } from "../../types/plugin";
import dashStyles from "../layout/Dashboard.module.css";
import styles from "./RepoListsSection.module.css";
import { formatTimeAgo } from "./timeAgo";
import { WorkspaceLinkBadge } from "./WorkspaceLinkBadge";
import { RepoListGroup } from "./RepoListGroup";
import { partitionByWorkspaceLink } from "./workspaceScmLink";
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

const SCOPES = [
  { value: "open", labelKey: "repo_scope_open", titleKey: "repo_issues_scope_open_title" },
  { value: "mine", labelKey: "repo_scope_mine", titleKey: "repo_issues_scope_mine_title" },
  {
    value: "assigned",
    labelKey: "repo_scope_assigned",
    titleKey: "repo_issues_scope_assigned_title",
  },
] as const satisfies readonly { value: IssueScope; labelKey: string; titleKey: string }[];

export interface RepoIssuesSectionProps {
  repoId: string;
}

export const RepoIssuesSection = memo(function RepoIssuesSection({
  repoId,
}: RepoIssuesSectionProps) {
  const { t } = useTranslation();
  // Sections render collapsed by default. The header still surfaces the
  // open-count badge so the project view tells you what's outstanding
  // upstream without forcing two long lists into the layout above the
  // workspaces grid. User clicks the chevron to expand.
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<IssueScope>("open");
  const { payload, isStale, loading, refresh } = useRepoOpenIssues(
    repoId,
    scope,
  );
  const [showAll, setShowAll] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const issues = useMemo(() => payload?.issues ?? [], [payload?.issues]);
  // Split out the issues a workspace is already on so they get their
  // own "In progress" group above the rest (issue #898). The row cap
  // applies only to `rest` — every dispatched issue stays visible,
  // even one that would otherwise sit past the cap.
  const workspaceScmLinks = useAppStore((s) => s.workspaceScmLinks);
  const workspaces = useAppStore((s) => s.workspaces);
  const { inProgress, rest } = useMemo(
    () =>
      partitionByWorkspaceLink(
        issues,
        { repoId, kind: "issue" },
        workspaceScmLinks,
        workspaces,
      ),
    [issues, repoId, workspaceScmLinks, workspaces],
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
          <span className={dashStyles.workspacesTitle}>{t("repo_issues_title")}</span>
          {issues.length > 0 && (
            // Bare count — tracks the active scope (e.g. "Mine" shows
            // mine-count, not total-open-count). The toggle next to it
            // disambiguates the label. Same shape as the PR section.
            <span className={dashStyles.headerCount}>{issues.length}</span>
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
                title={t(s.titleKey)}
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
            aria-label={t("repo_issues_refresh")}
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
          scope={scope}
          isStale={isStale}
          inProgress={inProgress}
          visibleRest={visibleRest}
          restTotal={rest.length}
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
  scope: IssueScope;
  /// True when `payload` is the previous scope's data (stale-while-
  /// revalidate). The list dims while real data is in flight.
  isStale: boolean;
  /// Issues that already have a workspace — rendered in their own group.
  inProgress: Issue[];
  /// The remaining issues, already capped to the visible-row limit.
  visibleRest: Issue[];
  /// Total count of `rest` before the cap — drives the "Show all" row.
  restTotal: number;
  /// Total count of all open issues — drives the empty/error branches.
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
  scope,
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
}: RepoIssuesBodyProps) {
  const { t } = useTranslation();
  // Render the skeleton whenever we don't yet have a payload for this
  // (repo, scope) pair — not just when `loading` flips true. When the
  // user clicks a different scope tab, the next render selects the new
  // scope's store slot, which is `undefined` until the fetch lands; if
  // we keyed the skeleton off `loading` alone, that intermediate paint
  // briefly shows the "empty" message before the fetch's loading=true
  // flips the spinner on.
  if (!payload) {
    return <SkeletonList />;
  }
  if (payload?.unsupported) {
    return (
      <div className={styles.muted}>
        {t("repo_issues_unsupported")}
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
        <span>{t("repo_issues_load_failed")}</span>
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
    return (
      <div className={styles.muted}>
        {scope === "mine"
          ? t("repo_issues_none_mine")
          : scope === "assigned"
            ? t("repo_issues_none_assigned")
            : t("repo_issues_none_open")}
      </div>
    );
  }

  const renderRow = (issue: Issue) => (
    <IssueRow
      key={issue.number}
      repoId={repoId}
      issue={issue}
      onOpen={onOpen}
      onCopyUrl={onCopyUrl}
    />
  );
  const showAllRow = !showAll && restTotal > visibleRest.length && (
    <li>
      <button type="button" className={styles.retryButton} onClick={onShowAll}>
        {t("repo_show_all", { count: restTotal })}
      </button>
    </li>
  );

  // When the requested scope hasn't loaded yet we render the previous
  // scope's rows (stale-while-revalidate). Dim them subtly so the user
  // sees the switch is in flight without ever staring at a blank list.
  const staleClass = isStale ? styles.stale : "";

  return (
    <div className={staleClass} aria-busy={isStale || undefined}>
      {payload?.error && (
        <div className={styles.errorBanner}>
          <span>{t("repo_issues_refresh_failed")}</span>
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
        // Dispatched issues get their own group above the rest. When
        // nothing is dispatched the list renders flat (the `else`
        // branch), so the common case is visually unchanged.
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

interface IssueRowProps {
  repoId: string;
  issue: Issue;
  onOpen: (url: string) => void;
  onCopyUrl: (url: string) => void;
}

function IssueRow({ repoId, issue, onOpen, onCopyUrl }: IssueRowProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const registry = useModelRegistry();
  const addToast = useAppStore((s) => s.addToast);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const linked = useWorkspaceScmLink(repoId, "issue", issue.number);
  const visibleLabels = issue.labels.slice(0, MAX_LABELS_VISIBLE);
  const overflow = Math.max(0, issue.labels.length - visibleLabels.length);

  const items: ContextMenuItem[] = [
    { label: t("repo_open_in_browser"), onSelect: () => onOpen(issue.url) },
    { label: t("repo_copy_url"), onSelect: () => onCopyUrl(issue.url) },
    { type: "separator" },
    // When a workspace is already on this issue, offer a jump to it
    // *above* — not instead of — "Send to new workspace": a second
    // workspace on the same issue is still one deliberate click away.
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
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
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

