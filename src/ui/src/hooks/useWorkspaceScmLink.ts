import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  resolveWorkspaceLink,
  type ResolvedWorkspaceLink,
} from "../components/project/workspaceScmLink";

/// Resolve the workspace (if any) currently working on a given issue/PR,
/// for the project-view "in progress" badge and the right-click "Go to
/// workspace" menu item.
///
/// Returns `null` when no workspace is linked, or when the linked
/// workspace has been archived / hard-deleted — see `resolveWorkspaceLink`
/// for the "keep row, hide badge" rationale (issue #898).
///
/// Also returns `null` whenever `projectViewIssuesPrsEnabled` is off:
/// the association is part of the project-view issues/PRs feature and
/// stays gated behind the same flag, so toggling the feature off hides
/// every badge live.
export function useWorkspaceScmLink(
  repoId: string,
  kind: "issue" | "pr",
  number: number,
): ResolvedWorkspaceLink | null {
  const enabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const links = useAppStore((s) => s.workspaceScmLinks);
  const workspaces = useAppStore((s) => s.workspaces);
  return useMemo(
    () =>
      enabled
        ? resolveWorkspaceLink(links, workspaces, { repoId, kind, number })
        : null,
    [enabled, links, workspaces, repoId, kind, number],
  );
}
