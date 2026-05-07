import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceContextMenuItems,
  type WorkspaceContextMenuLabels,
} from "./workspaceContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";

const labels: WorkspaceContextMenuLabels = {
  renameWorkspace: "Rename Workspace…",
  markAsUnread: "Mark as Unread",
  openInFileManager: "Open in File Manager",
  openInTerminal: "Open in Terminal",
  copyWorkingDirectory: "Copy Working Directory",
  copyClaudeSessionId: "Copy Claude Session ID",
  archiveWorkspace: "Archive",
  restoreWorkspace: "Restore",
  deleteWorkspace: "Delete",
};

function actionable(items: ContextMenuItem[]) {
  return items.filter((item) => item.type !== "separator");
}

function itemLabels(items: ContextMenuItem[]) {
  return actionable(items).map((item) => item.label);
}

describe("buildWorkspaceContextMenuItems", () => {
  it("builds active local workspace actions", () => {
    const noop = vi.fn();
    const items = buildWorkspaceContextMenuItems(
      {
        status: "Active",
        worktreePath: "/tmp/workspace",
        remote: false,
      },
      labels,
      {
        rename: noop,
        markAsUnread: noop,
        openInFileManager: noop,
        openInTerminal: noop,
        copyWorkingDirectory: noop,
        copyClaudeSessionId: noop,
        archive: noop,
      },
    );

    expect(itemLabels(items)).toEqual([
      "Rename Workspace…",
      "Mark as Unread",
      "Open in File Manager",
      "Open in Terminal",
      "Copy Working Directory",
      "Copy Claude Session ID",
      "Archive",
    ]);
  });

  it("builds archived local workspace actions and disables missing worktree actions", () => {
    const noop = vi.fn();
    const items = actionable(
      buildWorkspaceContextMenuItems(
        {
          status: "Archived",
          worktreePath: null,
          remote: false,
        },
        labels,
        {
          rename: noop,
          markAsUnread: noop,
          restore: noop,
          delete: noop,
        },
      ),
    );

    expect(items.map((item) => item.label)).toEqual([
      "Rename Workspace…",
      "Mark as Unread",
      "Open in File Manager",
      "Open in Terminal",
      "Copy Working Directory",
      "Copy Claude Session ID",
      "Restore",
      "Delete",
    ]);
    expect(items.find((item) => item.label === "Open in File Manager")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Open in Terminal")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Copy Working Directory")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Copy Claude Session ID")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Delete")?.variant).toBe("danger");
  });

  it("keeps remote workspace actions intentionally small", () => {
    const noop = vi.fn();
    const items = buildWorkspaceContextMenuItems(
      {
        status: "Active",
        worktreePath: "/remote/workspace",
        remote: true,
      },
      labels,
      {
        markAsUnread: noop,
        archive: noop,
      },
    );

    expect(itemLabels(items)).toEqual(["Mark as Unread", "Archive"]);
  });
});
