import type { ScmSummary } from "../types/plugin";
import type { Workspace } from "../types/workspace";

export type StatusBucketKey =
  | "in-progress"
  | "in-review"
  | "draft"
  | "merged"
  | "closed"
  | "archived";

export const STATUS_BUCKET_ORDER: StatusBucketKey[] = [
  "merged",
  "in-review",
  "draft",
  "in-progress",
  "closed",
  "archived",
];

export function statusBucketGroupKey(key: StatusBucketKey): string {
  return `status:${key}`;
}

export function bucketForWorkspace(
  ws: Workspace,
  scmSummary: Record<string, ScmSummary>,
): StatusBucketKey {
  if (ws.status === "Archived") return "archived";
  const summary = scmSummary[ws.id];
  if (!summary?.hasPr) return "in-progress";
  if (summary.prState === "merged") return "merged";
  if (summary.prState === "closed") return "closed";
  if (summary.prState === "draft") return "draft";
  return "in-review";
}

export function buildStatusBuckets(
  filteredWorkspaces: readonly Workspace[],
  scmSummary: Record<string, ScmSummary>,
): Map<StatusBucketKey, Workspace[]> {
  const buckets = new Map<StatusBucketKey, Workspace[]>();
  for (const key of STATUS_BUCKET_ORDER) buckets.set(key, []);
  for (const ws of filteredWorkspaces) {
    buckets.get(bucketForWorkspace(ws, scmSummary))!.push(ws);
  }
  return buckets;
}

/**
 * The visible workspace order in status group mode — exactly the rows the
 * sidebar paints, top to bottom. Concatenates non-empty buckets in
 * `STATUS_BUCKET_ORDER` and skips workspaces inside a collapsed bucket so
 * the jump-shortcut badge (1..9) never points at a row the user can't see.
 *
 * This is the single source of truth shared by the sidebar's badge
 * rendering and the `Cmd+N` keyboard handler.
 */
export function computeStatusVisibleWorkspaces(
  filteredWorkspaces: readonly Workspace[],
  scmSummary: Record<string, ScmSummary>,
  statusGroupCollapsed: Record<string, boolean>,
): Workspace[] {
  const buckets = buildStatusBuckets(filteredWorkspaces, scmSummary);
  const out: Workspace[] = [];
  for (const key of STATUS_BUCKET_ORDER) {
    const ws = buckets.get(key)!;
    if (ws.length === 0) continue;
    if (statusGroupCollapsed[statusBucketGroupKey(key)]) continue;
    out.push(...ws);
  }
  return out;
}
