import type { ScmSummary } from "../types/plugin";
import type { Workspace } from "../types/workspace";
import { getScmSortPriority } from "./scmSortPriority";

export const WORKSPACE_ORDER_MODE_PREFIX = "workspace_order_mode:";

export type WorkspaceOrderModeByRepo = Record<string, "manual">;

function compareCreatedAt(a: Workspace, b: Workspace): number {
  const byCreated = a.created_at.localeCompare(b.created_at);
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

function compareManualOrder(a: Workspace, b: Workspace): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return compareCreatedAt(a, b);
}

function compareAutoOrder(
  scmSummary: Record<string, ScmSummary>,
  a: Workspace,
  b: Workspace,
): number {
  const byScm =
    getScmSortPriority(scmSummary[a.id]) -
    getScmSortPriority(scmSummary[b.id]);
  if (byScm !== 0) return byScm;
  return compareCreatedAt(a, b);
}

export function isManualWorkspaceOrder(
  modes: WorkspaceOrderModeByRepo,
  repositoryId: string,
): boolean {
  return modes[repositoryId] === "manual";
}

export function orderRepoWorkspaces(
  repoWorkspaces: readonly Workspace[],
  scmSummary: Record<string, ScmSummary>,
  manualOrder: boolean,
): Workspace[] {
  return [...repoWorkspaces].sort((a, b) =>
    manualOrder ? compareManualOrder(a, b) : compareAutoOrder(scmSummary, a, b),
  );
}

export function repoIdFromWorkspaceOrderModeKey(key: string): string | null {
  return key.startsWith(WORKSPACE_ORDER_MODE_PREFIX)
    ? key.slice(WORKSPACE_ORDER_MODE_PREFIX.length)
    : null;
}
