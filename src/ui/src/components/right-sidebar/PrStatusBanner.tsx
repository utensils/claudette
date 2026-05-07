import { memo, useId, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  GitPullRequestArrow,
  GitPullRequestDraft,
  GitMerge,
  GitPullRequestClosed,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import { openUrl } from "../../services/tauri";
import { usePrBannerData, type BannerStatus } from "../../hooks/usePrBannerData";
import type { CiCheck } from "../../types/plugin";
import {
  ciCheckStatusLabel,
  sortCiChecks,
  summarizeCiChecks,
} from "../../utils/scmChecks";
import styles from "./PrStatusBanner.module.css";

const STATUS_CONFIG: Record<
  BannerStatus,
  {
    text: string;
    icon: typeof GitPullRequestArrow;
    bannerClass: string;
    fgClass: string;
  }
> = {
  ready: {
    text: "Ready to merge",
    icon: GitPullRequestArrow,
    bannerClass: styles.bannerReady,
    fgClass: styles.fgReady,
  },
  "ci-pending": {
    text: "CI running",
    icon: GitPullRequestArrow,
    bannerClass: styles.bannerPending,
    fgClass: styles.fgPending,
  },
  "ci-failed": {
    text: "CI failed",
    icon: GitPullRequestArrow,
    bannerClass: styles.bannerFailed,
    fgClass: styles.fgFailed,
  },
  open: {
    text: "Open",
    icon: GitPullRequestArrow,
    bannerClass: styles.bannerOpen,
    fgClass: styles.fgOpen,
  },
  draft: {
    text: "Draft",
    icon: GitPullRequestDraft,
    bannerClass: styles.bannerDraft,
    fgClass: styles.fgDraft,
  },
  merged: {
    text: "Merged",
    icon: GitMerge,
    bannerClass: styles.bannerMerged,
    fgClass: styles.fgMerged,
  },
  closed: {
    text: "Closed",
    icon: GitPullRequestClosed,
    bannerClass: styles.bannerClosed,
    fgClass: styles.fgClosed,
  },
};

export const PrStatusBanner = memo(function PrStatusBanner() {
  const { pr, checks, status } = usePrBannerData();
  const [checksOpen, setChecksOpen] = useState(false);
  const checksPanelId = useId();
  const sortedChecks = useMemo(() => sortCiChecks(checks), [checks]);
  const checksSummary = useMemo(() => summarizeCiChecks(checks), [checks]);

  if (!pr || !status) return null;

  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const hasChecks = sortedChecks.length > 0;

  return (
    <div className={`${styles.banner} ${config.bannerClass}`}>
      <button
        type="button"
        className={`${styles.prPill} ${config.fgClass}`}
        onClick={() => openUrl(pr.url)}
        title={`Open PR #${pr.number} in browser`}
      >
        <Icon size={14} />
        <span className={styles.prNumber}>#{pr.number}</span>
        <ExternalLink size={14} className={styles.externalIcon} />
      </button>

      {hasChecks ? (
        <button
          type="button"
          className={`${styles.statusButton} ${config.fgClass}`}
          onClick={() => setChecksOpen((open) => !open)}
          aria-expanded={checksOpen}
          aria-controls={checksPanelId}
          aria-haspopup="dialog"
          title={checksSummary.title}
        >
          <span className={styles.statusText}>{config.text}</span>
          <span className={styles.statusCount}>{checksSummary.total}</span>
          <ChevronRight
            size={14}
            className={`${styles.statusChevron} ${checksOpen ? styles.chevronOpen : ""}`}
            aria-hidden="true"
          />
        </button>
      ) : (
        <span className={`${styles.statusText} ${styles.statusSolo} ${config.fgClass}`}>
          {config.text}
        </span>
      )}

      {hasChecks && checksOpen && (
        <div
          id={checksPanelId}
          className={styles.checksPanel}
          role="dialog"
          aria-label={checksSummary.title}
        >
          <div className={styles.checksHeader}>
            <CheckStatusIcon status={checkSummaryStatus(checksSummary)} />
            <span className={styles.checksTitle}>{checksSummary.title}</span>
          </div>

          <div className={styles.checkList}>
            {sortedChecks.map((check) => (
              <CheckRow key={`${check.name}:${check.url ?? ""}`} check={check} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function checkSummaryStatus(summary: ReturnType<typeof summarizeCiChecks>): CiCheck["status"] {
  if (summary.failed > 0) return "failure";
  if (summary.pending > 0) return "pending";
  if (summary.cancelled > 0) return "cancelled";
  return "success";
}

function CheckRow({ check }: { check: CiCheck }) {
  const content = (
    <>
      <CheckStatusIcon status={check.status} />
      <span className={styles.checkName}>{check.name}</span>
      <span className={styles.checkStatus}>{ciCheckStatusLabel(check.status)}</span>
      {check.url && <ExternalLink size={12} className={styles.checkExternalIcon} />}
    </>
  );

  if (check.url) {
    return (
      <button
        type="button"
        className={`${styles.checkRow} ${styles.checkRowLink}`}
        onClick={() => openUrl(check.url!)}
        title={`Open ${check.name} check details`}
      >
        {content}
      </button>
    );
  }

  return <div className={styles.checkRow}>{content}</div>;
}

function CheckStatusIcon({ status }: { status: CiCheck["status"] }) {
  switch (status) {
    case "success":
      return <Check size={16} className={styles.checkIconSuccess} aria-hidden="true" />;
    case "failure":
      return <Circle size={10} className={styles.checkIconFailure} aria-hidden="true" />;
    case "cancelled":
      return <Circle size={10} className={styles.checkIconCancelled} aria-hidden="true" />;
    case "pending":
      return <LoaderCircle size={14} className={styles.checkIconPending} aria-hidden="true" />;
  }
}
