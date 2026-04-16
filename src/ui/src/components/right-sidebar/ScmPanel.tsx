import { memo, useCallback, useEffect, useState } from "react";
import {
  GitPullRequestArrow,
  GitPullRequestDraft,
  GitMerge,
  GitPullRequestClosed,
  Check,
  X,
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { loadScmDetail, scmRefresh, openUrl } from "../../services/tauri";
import type { PullRequest, CiCheck } from "../../types/plugin";
import styles from "./ScmPanel.module.css";

export const ScmPanel = memo(function ScmPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const scmDetail = useAppStore((s) => s.scmDetail);
  const scmDetailLoading = useAppStore((s) => s.scmDetailLoading);
  const setScmDetail = useAppStore((s) => s.setScmDetail);
  const setScmDetailLoading = useAppStore((s) => s.setScmDetailLoading);
  const setScmSummary = useAppStore((s) => s.setScmSummary);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDetail = useCallback(
    async (workspaceId: string) => {
      setScmDetailLoading(true);
      try {
        const detail = await loadScmDetail(workspaceId);
        setScmDetail(detail);
        // Also update summary
        if (detail.pull_request) {
          setScmSummary(workspaceId, {
            hasPr: true,
            prState: detail.pull_request.state,
            ciState: detail.pull_request.ci_status,
            lastUpdated: Date.now(),
          });
        } else {
          setScmSummary(workspaceId, {
            hasPr: false,
            prState: null,
            ciState: null,
            lastUpdated: Date.now(),
          });
        }
      } catch {
        // Silently fail — error will show in detail.error
      } finally {
        setScmDetailLoading(false);
      }
    },
    [setScmDetail, setScmDetailLoading, setScmSummary]
  );

  useEffect(() => {
    if (selectedWorkspaceId) {
      fetchDetail(selectedWorkspaceId);
    } else {
      setScmDetail(null);
    }
  }, [selectedWorkspaceId, fetchDetail, setScmDetail]);

  const handleRefresh = useCallback(async () => {
    if (!selectedWorkspaceId || refreshing) return;
    setRefreshing(true);
    try {
      const detail = await scmRefresh(selectedWorkspaceId);
      setScmDetail(detail);
      // Also update summary so sidebar badges stay in sync
      if (detail.pull_request) {
        setScmSummary(selectedWorkspaceId, {
          hasPr: true,
          prState: detail.pull_request.state,
          ciState: detail.pull_request.ci_status,
          lastUpdated: Date.now(),
        });
      } else {
        setScmSummary(selectedWorkspaceId, {
          hasPr: false,
          prState: null,
          ciState: null,
          lastUpdated: Date.now(),
        });
      }
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  }, [selectedWorkspaceId, refreshing, setScmDetail, setScmSummary]);

  if (!selectedWorkspaceId) {
    return <div className={styles.empty}>Select a workspace</div>;
  }

  if (scmDetailLoading && !scmDetail) {
    return (
      <div className={styles.empty}>
        <Loader2 size={16} className={styles.spin} />
        Loading SCM data...
      </div>
    );
  }

  if (!scmDetail?.provider) {
    return (
      <div className={styles.empty}>
        <AlertCircle size={16} />
        <span>No SCM provider detected</span>
        <span className={styles.hint}>
          Install a CLI tool like <code>gh</code> or <code>glab</code>
        </span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.providerBadge}>{scmDetail.provider}</span>
        <button
          className={styles.refreshBtn}
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh"
        >
          <RefreshCw size={13} className={refreshing ? styles.spin : ""} />
        </button>
      </div>

      {scmDetail.error && (
        <div className={styles.error}>{scmDetail.error}</div>
      )}

      {scmDetail.pull_request ? (
        <PrCard pr={scmDetail.pull_request} />
      ) : (
        <div className={styles.noPr}>No pull request for this branch</div>
      )}

      {scmDetail.ci_checks.length > 0 && (
        <div className={styles.checksSection}>
          <div className={styles.sectionTitle}>CI Checks</div>
          {scmDetail.ci_checks.map((check) => (
            <CiCheckRow key={check.name} check={check} />
          ))}
        </div>
      )}
    </div>
  );
});

function PrCard({ pr }: { pr: PullRequest }) {
  const PrIcon = getPrIcon(pr);
  const prColor = getPrColor(pr);

  return (
    <div className={styles.prCard}>
      <div className={styles.prHeader}>
        <PrIcon size={16} style={{ color: prColor }} />
        <span className={styles.prNumber}>#{pr.number}</span>
        <span className={styles.prState} style={{ color: prColor }}>
          {pr.state}
        </span>
        {pr.url && (
          <button
            className={styles.prLink}
            title="Open in browser"
            onClick={() => openUrl(pr.url)}
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className={styles.prTitle}>{pr.title}</div>
      <div className={styles.prMeta}>
        <span>{pr.author}</span>
        <span>
          {pr.branch} → {pr.base}
        </span>
      </div>
    </div>
  );
}

function CiCheckRow({ check }: { check: CiCheck }) {
  const StatusIcon = getCheckIcon(check.status);
  const color = getCheckColor(check.status);

  return (
    <div className={styles.checkRow}>
      <StatusIcon size={14} style={{ color }} />
      <span className={styles.checkName}>{check.name}</span>
      {check.url && (
        <button
          className={styles.checkLink}
          title="View details"
          onClick={() => openUrl(check.url!)}
        >
          <ExternalLink size={10} />
        </button>
      )}
    </div>
  );
}

function getPrIcon(pr: PullRequest) {
  switch (pr.state) {
    case "merged":
      return GitMerge;
    case "closed":
      return GitPullRequestClosed;
    case "draft":
      return GitPullRequestDraft;
    default:
      return GitPullRequestArrow;
  }
}

function getPrColor(pr: PullRequest): string {
  switch (pr.state) {
    case "merged":
      return "var(--purple, #a855f7)";
    case "closed":
      return "var(--red, #ef4444)";
    case "draft":
      return "var(--text-dim)";
    default:
      return "var(--green, #22c55e)";
  }
}

function getCheckIcon(status: CiCheck["status"]) {
  switch (status) {
    case "success":
      return Check;
    case "failure":
    case "cancelled":
      return X;
    default:
      return Loader2;
  }
}

function getCheckColor(status: CiCheck["status"]): string {
  switch (status) {
    case "success":
      return "var(--green, #22c55e)";
    case "failure":
      return "var(--red, #ef4444)";
    case "cancelled":
      return "var(--text-dim)";
    default:
      return "var(--yellow, #eab308)";
  }
}
