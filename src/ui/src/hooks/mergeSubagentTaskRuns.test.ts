import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSubagentRuns } from "../services/tauri/subagentRuns";
vi.mock("../services/tauri/subagentRuns", () => ({ getSubagentRuns: vi.fn() }));
import { useAppStore } from "../stores/useAppStore";
import { subagentSessionKey, type SubagentRun } from "../types/subagent";
import { deriveTaskState } from "./useTaskTracker";

function row(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    session_id: "parent", harness: "codex", run_id: "child-1", parent_run_id: null,
    assignment: "Review upgrade", status: "running", summary: null, tool_use_id: null,
    report_kind: null, report_summary: null, linked_session_id: null,
    revision: 1, updated_at: "2026-11-24T13:50:00Z", ...overrides,
  };
}

describe("subagent snapshots", () => {
  beforeEach(() => useAppStore.setState({ subagentRuns: {}, prunedSubagentIds: {} }));

  it("keeps late completions when an older reconnect snapshot lands, scoped by host and session", () => {
    const merge = useAppStore.getState().mergeSubagentRuns;
    const child = row({});
    const sibling = row({ run_id: "child-2", status: "needs_approval" });
    merge("paired", [child, sibling]);
    const done = row({ status: "completed", summary: "Upgrade tested", revision: 2 });
    merge("paired", [done]);
    merge("paired", [child, sibling, done]);
    merge(null, [child]);
    merge("paired", [row({ session_id: "other" })]);
    const snapshots = useAppStore.getState().subagentRuns;
    expect(snapshots[subagentSessionKey("paired", "parent")]).toEqual([done, sibling]);
    expect(snapshots[subagentSessionKey(null, "parent")]).toEqual([child]);
    expect(snapshots[subagentSessionKey("paired", "other")]).toHaveLength(1);
  });

  it("removes rolled-back runs without losing newer events or resurrecting a deleted snapshot", async () => {
    const store = useAppStore.getState();
    const fetch = vi.mocked(getSubagentRuns);
    const old = row({});
    const recent = row({ run_id: "other" });
    store.mergeSubagentRuns(null, [old, recent]);
    const pending = () => {
      let resolve!: (runs: SubagentRun[]) => void;
      const promise = new Promise<SubagentRun[]>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const obsolete = pending();
    const latest = pending();
    fetch.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(latest.promise);
    const first = store.reloadSubagentRuns(null, "parent");
    const retry = store.reloadSubagentRuns(null, "parent");
    const newer = row({ run_id: "other", revision: 2, status: "completed" });
    store.mergeSubagentRuns(null, [newer]);
    latest.resolve([]);
    await retry;
    obsolete.resolve([old, recent]);
    await first;
    expect(useAppStore.getState().subagentRuns[subagentSessionKey(null, "parent")]).toEqual([newer]);
  });

  it("accepts the restarted host's last-seen projection at the original revision", async () => {
    const store = useAppStore.getState();
    const active = row({ revision: 9 });
    store.mergeSubagentRuns("paired", [active]);
    vi.mocked(getSubagentRuns).mockResolvedValueOnce([{ ...active, status: "disconnected" }]);
    await store.reloadSubagentRuns("paired", "parent");
    expect(useAppStore.getState().subagentRuns[subagentSessionKey("paired", "parent")][0].status)
      .toBe("disconnected");
  });

  it("does not reconstruct a deleted worker from a paired client's older Task-tool checkpoint", async () => {
    const store = useAppStore.getState();
    const scope = subagentSessionKey("paired", "parent");
    const child = row({ harness: "claude", tool_use_id: "old-launch" });
    store.mergeSubagentRuns("paired", [child]);
    const oldActivity = {
      toolName: "Task", toolUseId: "old-launch", summary: "", collapsed: true, inputJson: "{}", resultText: "",
      agentStatus: "completed", agentResultText: "Old branch result",
    };
    const turns = [{ id: "old-checkpoint", activities: [oldActivity] }];
    expect(deriveTaskState(turns, []).history).toHaveLength(1);
    vi.mocked(getSubagentRuns).mockResolvedValueOnce([]);
    await store.reloadSubagentRuns("paired", "parent", true);
    const s = useAppStore.getState();
    const after = deriveTaskState(turns, [], s.subagentRuns[scope], s.prunedSubagentIds[scope]);
    expect(after.history).toEqual([]);
    expect(after.subagents).toEqual([]);
  });

  it("keeps worker outcomes independent of tool completion and the parent turn", () => {
    const rows = [
      row({ run_id: "review", tool_use_id: "wait", report_kind: "result", report_summary: "Review ready" }),
      row({ run_id: "verify", parent_run_id: "review", tool_use_id: "wait", status: "completed", summary: "92 passed" }),
    ];
    const state = deriveTaskState([{ id: "done", activities: [] }], [], rows);
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents[0].agent).toMatchObject({ nativeId: "review", report: "Review ready", status: "running" });
    expect(state.history).toHaveLength(1);
    expect(state.history[0].agent).toMatchObject({ nativeId: "verify", parentLabel: "Review upgrade", summary: "92 passed" });
  });

  it("moves a checkpointed Claude activity with a checklist exactly once when the durable stop arrives", () => {
    const state = deriveTaskState([{ id: "checkpoint", activities: [{
      toolName: "Agent", toolUseId: "launch", collapsed: true, inputJson: "{}", resultText: "", summary: "",
      agentTaskId: "child-1", agentStatus: "running",
      agentToolCalls: [{
        toolName: "TodoWrite", toolUseId: "todo", agentId: "child-1",
        input: { todos: [{ content: "Check imports", status: "completed" }] },
        status: "completed", startedAt: "", completedAt: "",
      }],
    }] }], [], [row({ harness: "claude", status: "failed", tool_use_id: null, summary: "Stopped at build" })]);
    expect(state.subagents).toEqual([]);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].tasks[0].description).toBe("Check imports");
    expect(state.history[0].agent?.status).toBe("failed");
  });
});
