import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import {
  summarizeAgentToolCallEdit,
  summarizeTurnEdits,
} from "./editActivitySummary";

function activity(overrides: Partial<ToolActivity>): ToolActivity {
  return {
    toolUseId: "tool-1",
    toolName: "Edit",
    inputJson: "{}",
    resultText: "done",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

describe("editActivitySummary", () => {
  it("summarizes direct Edit line churn", () => {
    const summary = summarizeTurnEdits([
      activity({
        inputJson: JSON.stringify({
          file_path: "/repo/src/app.ts",
          old_string: "one\ntwo\n",
          new_string: "one\nthree\nfour\n",
        }),
      }),
    ]);

    expect(summary).toMatchObject({
      added: 3,
      removed: 2,
      files: [{ filePath: "/repo/src/app.ts", added: 3, removed: 2 }],
    });
  });

  it("aggregates MultiEdit and nested agent edit calls by file", () => {
    const summary = summarizeTurnEdits([
      activity({
        toolName: "MultiEdit",
        inputJson: JSON.stringify({
          file_path: "src/app.ts",
          edits: [
            { old_string: "a", new_string: "a\nb" },
            { old_string: "c\nd", new_string: "c" },
          ],
        }),
        agentToolCalls: [
          {
            toolUseId: "nested-1",
            toolName: "Edit",
            agentId: "agent-1",
            input: {
              file_path: "src/app.ts",
              old_string: "old",
              new_string: "new\nnext",
            },
            status: "completed",
            startedAt: "2026-05-08T00:00:00.000Z",
          },
        ],
      }),
    ]);

    expect(summary).toMatchObject({
      added: 5,
      removed: 4,
      files: [{ filePath: "src/app.ts", added: 5, removed: 4 }],
    });
  });

  it("summarizes patch-shaped tool input", () => {
    const summary = summarizeAgentToolCallEdit({
      toolUseId: "patch-1",
      toolName: "apply_patch",
      agentId: "agent-1",
      input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          "-old",
          "+new",
          "+next",
          "*** End Patch",
        ].join("\n"),
      },
      status: "completed",
      startedAt: "2026-05-08T00:00:00.000Z",
    });

    expect(summary).toMatchObject({
      added: 2,
      removed: 1,
      files: [{ filePath: "src/app.ts", added: 2, removed: 1 }],
    });
  });
});
