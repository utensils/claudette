import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/useAppStore";
import { loadScmDetail } from "../services/tauri";
import type { CiCheck, PullRequest } from "../types/plugin";
import { summarizeCiChecks } from "../utils/scmChecks";

export type BannerStatus =
  | "ready"
  | "ci-pending"
  | "ci-failed"
  | "open"
  | "draft"
  | "merged"
  | "closed";

export function deriveBannerStatus(
  pr: PullRequest,
  checks: readonly CiCheck[] = [],
): BannerStatus {
  if (pr.state === "draft") return "draft";
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  // pr.state === "open"
  if (pr.ci_status === "success") return "ready";
  if (pr.ci_status === "pending") return "ci-pending";
  if (pr.ci_status === "failure") return "ci-failed";
  const checkSummary = summarizeCiChecks(checks);
  if (checkSummary.failed > 0) return "ci-failed";
  if (checkSummary.pending > 0) return "ci-pending";
  if (checkSummary.total > 0 && checkSummary.cancelled === 0) return "ready";
  return "open";
}

export function usePrBannerData(): {
  pr: PullRequest | null;
  checks: CiCheck[];
  status: BannerStatus | null;
} {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const scmSummary = useAppStore((s) =>
    selectedWorkspaceId ? s.scmSummary[selectedWorkspaceId] : undefined
  );
  const scmDetail = useAppStore((s) => s.scmDetail);
  const setScmDetail = useAppStore((s) => s.setScmDetail);
  const setScmDetailLoading = useAppStore((s) => s.setScmDetailLoading);
  const setScmSummary = useAppStore((s) => s.setScmSummary);

  const fetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (!scmSummary?.hasPr) return;

    // Already have detail for this workspace
    if (scmDetail?.workspace_id === selectedWorkspaceId) return;
    // Already fetched for this workspace
    if (fetchedForRef.current === selectedWorkspaceId) return;

    fetchedForRef.current = selectedWorkspaceId;

    setScmDetailLoading(true);
    loadScmDetail(selectedWorkspaceId)
      .then((detail) => {
        setScmDetail(detail);
        if (!selectedWorkspaceId) return;
        if (detail.pull_request) {
          setScmSummary(selectedWorkspaceId, {
            hasPr: true,
            prState: detail.pull_request.state,
            ciState: detail.pull_request.ci_status,
            lastUpdated: Date.now(),
          });
        } else {
          // PR disappeared (merged/closed) since the last poll — clear
          // the summary so sidebar badges/banner stop showing the old state.
          setScmSummary(selectedWorkspaceId, {
            hasPr: false,
            prState: null,
            ciState: null,
            lastUpdated: Date.now(),
          });
        }
      })
      .catch(() => {
        // Reset so a retry is possible on next render cycle
        fetchedForRef.current = null;
      })
      .finally(() => setScmDetailLoading(false));
  }, [
    selectedWorkspaceId,
    scmSummary?.hasPr,
    scmDetail?.workspace_id,
    setScmDetail,
    setScmDetailLoading,
    setScmSummary,
  ]);

  if (
    !selectedWorkspaceId ||
    !scmDetail?.pull_request ||
    scmDetail.workspace_id !== selectedWorkspaceId
  ) {
    return { pr: null, checks: [], status: null };
  }

  return {
    pr: scmDetail.pull_request,
    checks: scmDetail.ci_checks,
    status: deriveBannerStatus(scmDetail.pull_request, scmDetail.ci_checks),
  };
}
