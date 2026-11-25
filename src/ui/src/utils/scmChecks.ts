import i18n from "../i18n";
import type { CiCheck, PullRequest, ScmSummary } from "../types/plugin";

export type CiCheckTone =
  | "success"
  | "failure"
  | "pending"
  | "cancelled"
  | "skipped";

export interface CiCheckSummary {
  title: string;
  total: number;
  failed: number;
  pending: number;
  cancelled: number;
  /** Checks that were deliberately not run (`if:` false on a GitHub
   *  workflow, `rules:` excluded a GitLab job, manual GitLab job not
   *  triggered). Counted separately from `cancelled` because a skipped
   *  check is informational, not a soft-fail. */
  skipped: number;
  passed: number;
}

const STATUS_PRIORITY: Record<CiCheckTone, number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  // Skipped sorts after cancelled / before success so the user sees
  // problem statuses, then in-progress, then "didn't run", then green.
  skipped: 3,
  success: 4,
};

export function ciCheckStatusLabel(status: CiCheckTone): string {
  switch (status) {
    case "success":
      return i18n.t("modals:scm_check_passed");
    case "failure":
      return i18n.t("modals:scm_check_failing");
    case "pending":
      return i18n.t("modals:scm_check_running");
    case "cancelled":
      return i18n.t("modals:scm_check_cancelled");
    case "skipped":
      return i18n.t("modals:scm_check_skipped");
  }
}

export function summarizeCiChecks(checks: readonly CiCheck[]): CiCheckSummary {
  const failed = checks.filter((check) => check.status === "failure").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const cancelled = checks.filter((check) => check.status === "cancelled").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const passed = checks.filter((check) => check.status === "success").length;

  let title = i18n.t("modals:scm_checks_title");
  if (failed > 0) {
    title = i18n.t("modals:scm_checks_failing", { count: failed });
  } else if (pending > 0) {
    title = i18n.t("modals:scm_checks_running", { count: pending });
  } else if (cancelled > 0) {
    title = i18n.t("modals:scm_checks_cancelled", { count: cancelled });
  } else if (checks.length > 0) {
    // All-skipped: rare in practice (CI has at least one always-on job)
    // but valid in test PRs and small repos. Surface it as "passed" for
    // the title since nothing is failing or running, then disambiguate
    // in the per-check rows below.
    title = i18n.t("modals:scm_checks_passed", { count: checks.length });
  }

  return {
    title,
    total: checks.length,
    failed,
    pending,
    cancelled,
    skipped,
    passed,
  };
}

export function deriveScmCiState(
  ciStatus: PullRequest["ci_status"],
  checks: readonly CiCheck[],
): ScmSummary["ciState"] {
  if (ciStatus) return ciStatus;

  const summary = summarizeCiChecks(checks);
  if (summary.failed > 0) return "failure";
  if (summary.pending > 0) return "pending";
  // Skipped checks are informational — when every non-skipped check
  // passed, the overall state is success even if the only checks present
  // were skipped (e.g. a small PR that only triggered conditional jobs).
  if (summary.total > 0 && summary.cancelled === 0) return "success";
  return null;
}

export function sortCiChecks(checks: readonly CiCheck[]): CiCheck[] {
  return [...checks].sort((a, b) => {
    const statusDelta = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (statusDelta !== 0) return statusDelta;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
