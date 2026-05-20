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
/// Returns `null` — i.e. the project view shows no badge — when:
///   - no link matches the target item, OR
///   - the linked workspace has been hard-deleted (absent from
///     `workspaces`), OR
///   - the linked workspace exists but is archived.
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
  const link = Object.values(links).find(
    (l) =>
      l.repo_id === target.repoId &&
      l.kind === target.kind &&
      l.number === target.number,
  );
  if (!link) return null;
  // The freshness filter — "keep row, hide badge". A link can outlive
  // its workspace in-session (hard-deleted, absent here until the next
  // boot drops the row via the FK cascade), or point at an archived
  // workspace whose row we intentionally keep. Both hide the badge.
  const workspace = workspaces.find((w) => w.id === link.workspace_id);
  if (!workspace || workspace.status === "Archived") return null;
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    link,
  };
}
