import type { ScmSummary } from "../types/plugin";

export function getScmSortPriority(summary: ScmSummary | undefined): number {
  if (!summary || !summary.hasPr) return 5;

  switch (summary.prState) {
    case "open":
      switch (summary.ciState) {
        case "success":
          return 0;
        case "pending":
          return 1;
        case "failure":
          return 2;
        default:
          return 3;
      }
    case "draft":
      return 4;
    case "merged":
      return 6;
    case "closed":
      return 7;
    default:
      return 5;
  }
}
