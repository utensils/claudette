import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendRemoteCommand = vi.fn();
const invoke = vi.fn();

vi.mock("./remote", () => ({
  sendRemoteCommand: (...args: unknown[]) => sendRemoteCommand(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { setRemoteRoutingResolver } from "./remoteRouting";
import { submitPlanApproval } from "./chat";
import { createChatSession } from "./chatSessions";
import { closePty, spawnPty, writePty } from "./pty";
import { loadCommitFileDiff } from "./diff";

describe("remote routing", () => {
  beforeEach(() => {
    sendRemoteCommand.mockReset();
    invoke.mockReset();
    setRemoteRoutingResolver({
      connectionForWorkspace: (id) => (id === "remote-ws" ? "conn-1" : null),
      connectionForSession: (id) => (id === "remote-session" ? "conn-1" : null),
    });
  });

  afterEach(() => {
    setRemoteRoutingResolver({
      connectionForWorkspace: () => null,
      connectionForSession: () => null,
    });
  });

  it("sends session-scoped calls for remote sessions over the connection", async () => {
    sendRemoteCommand.mockResolvedValue(null);
    await submitPlanApproval("remote-session", "tool-1", true);
    expect(invoke).not.toHaveBeenCalled();
    expect(sendRemoteCommand).toHaveBeenCalledWith("conn-1", "submit_plan_approval", {
      chat_session_id: "remote-session",
      tool_use_id: "tool-1",
      approved: true,
      reason: null,
    });
  });

  it("keeps local sessions on the local command", async () => {
    invoke.mockResolvedValue(undefined);
    await submitPlanApproval("local-session", "tool-1", false, "no");
    expect(sendRemoteCommand).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("submit_plan_approval", {
      sessionId: "local-session",
      toolUseId: "tool-1",
      approved: false,
      reason: "no",
    });
  });

  it("creates sessions for remote workspaces on the remote", async () => {
    sendRemoteCommand.mockResolvedValue({ id: "s1" });
    await expect(createChatSession("remote-ws")).resolves.toEqual({ id: "s1" });
    expect(sendRemoteCommand).toHaveBeenCalledWith("conn-1", "create_chat_session", {
      workspace_id: "remote-ws",
    });
  });

  it("reads a remote workspace's commit diffs on its own machine", async () => {
    sendRemoteCommand.mockResolvedValue({ path: "a.ts", hunks: [] });
    await loadCommitFileDiff("/remote/wt", "abc123", "a.ts", "remote-ws");
    expect(invoke).not.toHaveBeenCalled();
    expect(sendRemoteCommand).toHaveBeenCalledWith("conn-1", "load_commit_file_diff", {
      workspace_id: "remote-ws",
      worktree_path: "/remote/wt",
      commit_hash: "abc123",
      file_path: "a.ts",
    });
  });

  it("routes a remote terminal's writes and close to its connection", async () => {
    sendRemoteCommand.mockResolvedValueOnce({ pty_id: 2 ** 40 });
    const ptyId = await spawnPty("/remote/wt", "ws", "remote-ws", "/repo", "main", "b");
    expect(ptyId).toBe(2 ** 40);

    sendRemoteCommand.mockResolvedValue(null);
    await writePty(ptyId, [104]);
    expect(sendRemoteCommand).toHaveBeenLastCalledWith("conn-1", "write_pty", {
      pty_id: ptyId,
      data: [104],
    });

    await closePty(ptyId);
    await writePty(ptyId, [105]);
    // Once closed, the alias is forgotten and falls back to the local path.
    expect(invoke).toHaveBeenCalledWith("write_pty", { ptyId, data: [105] });
  });
});
