import { describe, expect, it, vi } from "vitest";
import {
  applyCommandLineEvent,
  approvalDetailValue,
  extractAssistantMessageParts,
  firstApprovalDetailString,
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

describe("extractAssistantMessageParts", () => {
  it("combines final text and thinking blocks from the assistant stream event", () => {
    const parts = extractAssistantMessageParts([
      { type: "thinking", thinking: "Check the renderer. " },
      { type: "text", text: "Done" },
      { type: "thinking", thinking: "Reuse ThinkingBlock." },
      { type: "text", text: "." },
    ]);

    expect(parts).toEqual({
      text: "Done.",
      thinking: "Check the renderer. Reuse ThinkingBlock.",
    });
  });

  it("ignores tool and unknown blocks", () => {
    const parts = extractAssistantMessageParts([
      { type: "tool_use", id: "tool-1", name: "Edit" },
      { type: "Unknown" },
      { type: "text", text: "Visible" },
    ]);

    expect(parts).toEqual({ text: "Visible", thinking: "" });
  });
});

describe("approvalDetailValue", () => {
  it("formats supported detail values without surfacing raw JSON", () => {
    expect(approvalDetailValue("  /repo  ")).toBe("/repo");
    expect(approvalDetailValue(["read", " write ", ""])).toBe("read, write");
  });

  it("drops unknown object and scalar shapes", () => {
    expect(approvalDetailValue({ foo: "bar" })).toBeNull();
    expect(approvalDetailValue(42)).toBeNull();
    expect(approvalDetailValue(["read", 42])).toBeNull();
  });
});

describe("firstApprovalDetailString", () => {
  it("skips empty and unsupported candidates before using a fallback path", () => {
    expect(
      firstApprovalDetailString(
        {
          path: "",
          filePath: 42,
          grantRoot: "  /repo/src/app.ts  ",
        },
        ["path", "filePath", "grantRoot"],
      ),
    ).toBe("/repo/src/app.ts");
  });

  it("returns null when no string candidate can be displayed", () => {
    expect(
      firstApprovalDetailString(
        {
          path: "",
          filePath: ["not", "a", "path"],
          grantRoot: null,
        },
        ["path", "filePath", "grantRoot"],
      ),
    ).toBeNull();
  });
});
