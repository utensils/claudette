import { describe, expect, it, vi } from "vitest";
import {
  buildTmuxAttachCommand,
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
  copyTmuxAttachCommand: "Copy tmux attach command",
  archiveWorkspace: "Archive",
  restoreWorkspace: "Restore",
  deleteWorkspace: "Delete",
};

type ActionItem = Extract<ContextMenuItem, { onSelect: unknown }>;

function actionable(items: ContextMenuItem[]): ActionItem[] {
  return items.filter(
    (item): item is ActionItem =>
      item.type !== "separator" &&
      item.type !== "submenu" &&
      item.type !== "header",
  );
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

  it("shows tmux attach menu item only when hostKind is tmux", () => {
    const noop = vi.fn();
    // Tmux session present → item appears.
    const withTmux = buildWorkspaceContextMenuItems(
      {
        status: "Active",
        worktreePath: "/tmp/workspace",
        remote: false,
        tmuxAttachSid: "claude-abc123",
      },
      labels,
      {
        rename: noop,
        markAsUnread: noop,
        openInFileManager: noop,
        openInTerminal: noop,
        copyWorkingDirectory: noop,
        copyClaudeSessionId: noop,
        copyTmuxAttachCommand: noop,
        archive: noop,
      },
    );
    expect(itemLabels(withTmux)).toContain("Copy tmux attach command");

    // No interactive sessions → item hidden.
    const noInteractive = buildWorkspaceContextMenuItems(
      {
        status: "Active",
        worktreePath: "/tmp/workspace",
        remote: false,
        tmuxAttachSid: null,
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
    expect(itemLabels(noInteractive)).not.toContain("Copy tmux attach command");

    // Sidecar session (no tmux sid) → item hidden.
    const sidecarOnly = buildWorkspaceContextMenuItems(
      {
        status: "Active",
        worktreePath: "/tmp/workspace",
        remote: false,
        // The sidebar selector returns null when the only host is sidecar;
        // we model that here by simply not setting tmuxAttachSid.
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
    expect(itemLabels(sidecarOnly)).not.toContain("Copy tmux attach command");
  });

  it("copies the tmux attach command to clipboard", async () => {
    // Spy on navigator.clipboard.writeText. jsdom may or may not provide
    // the clipboard surface, so install a writable stub for the duration
    // of the test.
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = (
      navigator as unknown as { clipboard?: Clipboard }
    ).clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const sid = "claude-abc123";
      const items = buildWorkspaceContextMenuItems(
        {
          status: "Active",
          worktreePath: "/tmp/workspace",
          remote: false,
          tmuxAttachSid: sid,
        },
        labels,
        {
          markAsUnread: vi.fn(),
          // Mirror the Sidebar wiring: the callback invokes
          // navigator.clipboard.writeText with the tmux attach command.
          copyTmuxAttachCommand: async () => {
            await navigator.clipboard.writeText(buildTmuxAttachCommand(sid));
          },
        },
      );

      const tmuxItem = actionable(items).find(
        (item) => item.label === "Copy tmux attach command",
      );
      expect(tmuxItem).toBeDefined();
      expect(tmuxItem?.disabled).toBeFalsy();

      // Invoke the menu item's onSelect — the same path the ContextMenu
      // component runs on click.
      await tmuxItem?.onSelect?.();

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(`tmux attach-session -t ${sid}`);
    } finally {
      if (originalClipboard === undefined) {
        // jsdom default: remove the property we installed.
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
      } else {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: originalClipboard,
        });
      }
    }
  });
});
