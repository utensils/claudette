import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import i18n from "../../i18n";
import type { ScmSummary } from "../../types/plugin";

/**
 * Visual spec for the PR-state status icon shown on a workspace row /
 * card. Shared between the Sidebar workspace list and the Dashboard
 * "Active Workspaces" cards so the two surfaces never diverge on what a
 * merged / open / draft / closed PR looks like.
 *
 * Callers are responsible for the wrapper element + className (each
 * surface owns its own CSS-module styling for the icon slot).
 */
export interface ScmPrIconSpec {
  Icon: LucideIcon;
  color: string;
  /** Default English title; surfaces with i18n can override via the
   *  returned PR / CI state if they need a localized tooltip. */
  title: string;
  prState: NonNullable<ScmSummary["prState"]>;
  ciState: ScmSummary["ciState"];
}

/**
 * Resolve the PR-state icon for a workspace from its cached SCM summary.
 * Returns `null` when the workspace has no associated PR — callers
 * should fall through to their existing "stopped / idle" rendering.
 *
 * Precedence within PR state:
 *   merged → GitMerge (badge-plan)
 *   closed → GitPullRequestClosed (status-stopped)
 *   draft  → GitPullRequestDraft (text-dim)
 *   open   → GitPullRequestArrow tinted by CI state
 *            (failure→stopped, pending→ask, otherwise→done)
 */
export function resolveScmPrIcon(
  summary: ScmSummary | undefined,
): ScmPrIconSpec | null {
  if (!summary?.hasPr || !summary.prState) return null;
  const { prState, ciState } = summary;
  const Icon =
    prState === "merged" ? GitMerge
      : prState === "closed" ? GitPullRequestClosed
        : prState === "draft" ? GitPullRequestDraft
          : GitPullRequestArrow;
  const color =
    prState === "merged" ? "var(--badge-plan)"
      : prState === "closed" ? "var(--status-stopped)"
        : prState === "draft" ? "var(--text-dim)"
          : ciState === "failure" ? "var(--status-stopped)"
            : ciState === "pending" ? "var(--badge-ask)"
              : "var(--badge-done)";
  return {
    Icon,
    color,
    title: ciState
      ? i18n.t("pr_status_title_ci", {
          state: i18n.t(`pr_state_${prState}`),
          ci: i18n.t(`ci_state_${ciState}`),
        })
      : i18n.t("pr_status_title", { state: i18n.t(`pr_state_${prState}`) }),
    prState,
    ciState,
  };
}
