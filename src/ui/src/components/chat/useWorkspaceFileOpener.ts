import { useCallback } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { tryOpenAgentFileTab } from "../../utils/agentFiles";
import { monacoFileLinkTarget } from "./chatFileLinks";
import { useWorkspaceFileIndex } from "./useWorkspaceFileIndex";

export interface WorkspaceFileOpener {
  /** Open a file path in this workspace's Monaco tab. Returns `true` when
   *  the path resolved to a workspace-relative target and a tab was opened;
   *  `false` when the path is not reachable via this worktree (caller may
   *  fall back to the OS opener for true out-of-project paths). */
  openFile: (path: string) => boolean;
  /** Resolve a chat-visible path string to its workspace-relative form, or
   *  `null` if the file isn't tracked under this worktree. Used by the
   *  markdown `<a>` override to decide whether a path should render as a
   *  Monaco-bound button or as inert prose. */
  resolveFilePath: (path: string) => string | null;
}

/** Build the `{ openFile, resolveFilePath }` pair a chat-surface
 *  `<MessageMarkdown>` needs to route file-path clicks into Monaco.
 *
 *  Currently used by `PlanApprovalCard`; the same pattern still lives
 *  inline in `MessagesWithTurns` (`openFileInMonaco` at ~L481) and
 *  `StreamingMessage` (~L59). Those callers were intentionally left
 *  alone in the bug-fix PR to keep the diff surgical — folding them
 *  into this hook is a deliberate follow-up so a future change reaches
 *  every chat-rendered markdown surface in one place rather than three. */
export function useWorkspaceFileOpener(
  workspaceId: string | null | undefined,
): WorkspaceFileOpener {
  const openFileTab = useAppStore((s) => s.openFileTab);
  const worktreePath = useAppStore((s) =>
    workspaceId
      ? s.workspaces.find((w) => w.id === workspaceId)?.worktree_path
      : undefined,
  );
  const fileIndex = useWorkspaceFileIndex(workspaceId);

  const openFile = useCallback(
    (filePath: string) => {
      if (!workspaceId) return false;
      // Agent-managed files (plans, memory) live outside the worktree —
      // route them to a read-only Monaco tab before worktree resolution.
      if (tryOpenAgentFileTab(workspaceId, filePath, openFileTab)) return true;
      const target = monacoFileLinkTarget(filePath, worktreePath);
      if (!target) return false;
      openFileTab(workspaceId, target.path, target.revealTarget);
      return true;
    },
    [openFileTab, workspaceId, worktreePath],
  );

  return { openFile, resolveFilePath: fileIndex.resolve };
}
