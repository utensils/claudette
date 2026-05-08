import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { forkWorkspaceAtCheckpoint } from "./tauri";

describe("forkWorkspaceAtCheckpoint", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  // Contract pin: the Tauri command name and its camelCase argument shape
  // are the wire between the React fork button and the Rust fork code.
  // If someone renames the command or its params (snake_case slip,
  // accidental refactor, etc.) the chat-side click silently no-ops because
  // Tauri throws "command not found" deep in a try/catch and the user just
  // sees nothing happen — which is exactly how the original "broken" report
  // came in.  Asserting the literal strings here makes that drift loud.
  it("invokes fork_workspace_at_checkpoint with camelCase workspaceId + checkpointId", async () => {
    invokeMock.mockResolvedValueOnce({
      workspace: {
        id: "ws-new",
        repository_id: "r-1",
        name: "src-fork",
        branch_name: "u/src-fork",
        worktree_path: "/tmp/src-fork",
        status: "Active",
        agent_status: "Idle",
        status_line: "",
        created_at: "",
        sort_order: 0,
      },
      session_resumed: true,
    });

    const result = await forkWorkspaceAtCheckpoint("ws-src", "cp-42");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fork_workspace_at_checkpoint", {
      workspaceId: "ws-src",
      checkpointId: "cp-42",
    });
    // session_resumed is the field ChatPanel doesn't read today, but it's
    // part of the persisted contract — flag any rename so future telemetry
    // / banner work that wants to surface "context preserved" can rely on it.
    expect(result.session_resumed).toBe(true);
    expect(result.workspace.id).toBe("ws-new");
  });

  it("propagates errors so the ChatPanel try/catch can surface them", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Checkpoint not found"));
    await expect(
      forkWorkspaceAtCheckpoint("ws-src", "cp-missing"),
    ).rejects.toThrow("Checkpoint not found");
  });
});
