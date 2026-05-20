import type { Workspace } from "../../types/workspace";
import type { WorkspaceScmLink } from "../../types/plugin";

/// A resolved issue/PR -> workspace association, already narrowed to a
/// workspace that is safe to surface in the project view: it still
/// exists and is not archived. The "in progress" badge renders only
/// when `resolveWorkspaceLink` returns one of these.
export interface ResolvedWorkspaceLink {
  workspaceId: string;
  workspaceName: string;
  /// The raw persisted link — carries `url` / `title` / `kind` for the
  /// workspace-side breadcrumb and tooltip.
  link: WorkspaceScmLink;
}

/// The SCM item a project-view row represents.
export interface ScmItemTarget {
  repoId: string;
  kind: "issue" | "pr";
  number: number;
}

/// Find the workspace currently working on a given SCM item.
///
/// Issue #898 chose "keep row, hide badge": the backend never deletes a
/// link when its workspace is archived (only the FK cascade drops it on
/// a hard-delete), so the freshness filter lives here on the read side.
/// That keeps an archive -> restore round-trip from losing the link.
///
/// An item can have *several* links — the right-click menu deliberately
/// keeps "Send to new workspace" available even when a link already
/// exists, so a user can spin up a second workspace on the same issue.
/// The freshness filter is therefore applied across *every* candidate:
/// a stale (archived / hard-deleted) link must never shadow a newer
/// active one. When more than one active link exists, the most recently
/// created wins so the badge tracks the latest workspace.
///
/// Returns `null` — i.e. the project view shows no badge — when no link
/// matches the target item, or when every matching link points at a
/// workspace that has been hard-deleted (absent from `workspaces`) or
/// archived.
///
/// `links` is keyed by `workspace_id` (see `ScmSlice.workspaceScmLinks`),
/// so this scans its values; the map is workspace-count-sized (a handful
/// in practice), and the project view memoizes per row.
export function resolveWorkspaceLink(
  links: Record<string, WorkspaceScmLink>,
  workspaces: Workspace[],
  target: ScmItemTarget,
): ResolvedWorkspaceLink | null {
  // Match on all three of repo / kind / number: an issue #N and a PR #N
  // can share a number, so the number alone is not a unique key.
  const candidates = Object.values(links).filter(
    (l) =>
      l.repo_id === target.repoId &&
      l.kind === target.kind &&
      l.number === target.number,
  );
  // Newest first — `created_at` is the SQLite `datetime('now')` string
  // (`YYYY-MM-DD HH:MM:SS`), which sorts lexically.
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Apply the freshness filter to every candidate, not just the first:
  // a link can outlive its workspace in-session (hard-deleted, absent
  // here until the next boot drops the row via the FK cascade) or point
  // at an archived workspace whose row we intentionally keep. Either
  // way it must not shadow a newer active link for the same item.
  for (const link of candidates) {
    const workspace = workspaces.find((w) => w.id === link.workspace_id);
    if (workspace && workspace.status !== "Archived") {
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        link,
      };
    }
  }
  return null;
}
