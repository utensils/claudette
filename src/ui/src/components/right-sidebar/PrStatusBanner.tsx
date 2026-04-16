import { memo } from "react";
import {
  GitPullRequestArrow,
  GitPullRequestDraft,
  GitMerge,
  GitPullRequestClosed,
  ExternalLink,
} from "lucide-react";
import { openUrl } from "../../services/tauri";
import { usePrBannerData, type BannerStatus } from "../../hooks/usePrBannerData";
import styles from "./PrStatusBanner.module.css";

const STATUS_CONFIG: Record<
  BannerStatus,
  {
    text: string;
    icon: typeof GitPullRequestArrow;
    bg: string;
    fg: string;
  }
> = {
  ready: {
    text: "Ready to merge",
    icon: GitPullRequestArrow,
    bg: "rgba(34, 197, 94, 0.12)",
    fg: "#22c55e",
  },
  "ci-pending": {
    text: "CI running",
    icon: GitPullRequestArrow,
    bg: "rgba(234, 179, 8, 0.12)",
    fg: "#eab308",
  },
  "ci-failed": {
    text: "CI failed",
    icon: GitPullRequestArrow,
    bg: "rgba(239, 68, 68, 0.12)",
    fg: "#ef4444",
  },
  open: {
    text: "Open",
    icon: GitPullRequestArrow,
    bg: "rgba(34, 197, 94, 0.08)",
    fg: "#22c55e",
  },
  draft: {
    text: "Draft",
    icon: GitPullRequestDraft,
    bg: "var(--hover-bg)",
    fg: "var(--text-dim)",
  },
  merged: {
    text: "Merged",
    icon: GitMerge,
    bg: "rgba(168, 85, 247, 0.12)",
    fg: "#a855f7",
  },
  closed: {
    text: "Closed",
    icon: GitPullRequestClosed,
    bg: "var(--hover-bg)",
    fg: "var(--text-dim)",
  },
};

export const PrStatusBanner = memo(function PrStatusBanner() {
  const { pr, status } = usePrBannerData();

  if (!pr || !status) return null;

  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <div className={styles.banner} style={{ background: config.bg }}>
      <button
        className={styles.prPill}
        style={{ borderColor: config.fg, color: config.fg }}
        onClick={() => openUrl(pr.url)}
        title={`Open PR #${pr.number} in browser`}
      >
        <Icon size={14} />
        <span className={styles.prNumber}>#{pr.number}</span>
        <ExternalLink size={14} className={styles.externalIcon} />
      </button>
      <span className={styles.statusText} style={{ color: config.fg }}>
        {config.text}
      </span>
    </div>
  );
});
