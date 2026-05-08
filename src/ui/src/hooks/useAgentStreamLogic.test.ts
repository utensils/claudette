import { describe, expect, it, vi } from "vitest";
import {
  applyCommandLineEvent,
  type CommandLineApplyDeps,
} from "./useAgentStreamLogic";

function makeDeps(currentValue: string | null): {
  deps: CommandLineApplyDeps;
  update: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const persist = vi.fn(async () => undefined);
  return {
    deps: {
      getCurrent: () => currentValue,
      updateSession: update,
      persist,
    },
    update,
    persist,
  };
}

describe("applyCommandLineEvent", () => {
  it("returns false for non-command_line subtypes (no-op)", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "task_started", command_line: null },
      "s1",
      deps,
    );
    expect(handled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns false when command_line is not a string", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: null },
      "s1",
      deps,
    );
    expect(handled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("updates + persists when current is null (first emit)", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: "claude --print …" },
      "s1",
      deps,
    );
    expect(handled).toBe(true);
    expect(update).toHaveBeenCalledWith("s1", "claude --print …");
    expect(persist).toHaveBeenCalledWith("s1", "claude --print …");
  });

  it("short-circuits when current is already non-null (first-emit-wins)", () => {
    const { deps, update, persist } = makeDeps("claude --print existing");
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: "claude --print new" },
      "s1",
      deps,
    );
    expect(handled).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});
