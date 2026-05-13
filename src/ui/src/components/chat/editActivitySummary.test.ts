import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import {
  previewLinesFromFileDiff,
  summarizeDiffFiles,
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
    expect(summary?.files[0].previewLines).toMatchObject([
      { type: "removed", content: "one" },
      { type: "removed", content: "two" },
      { type: "added", content: "one" },
      { type: "added", content: "three" },
      { type: "added", content: "four" },
    ]);
  });

  it("summarizes Codex-style Edit aliases with the shared file edit stats", () => {
    const summary = summarizeTurnEdits([
      activity({
        toolName: "Edit",
        inputJson: JSON.stringify({
          path: "simple-wave.svg",
          old_str: "<text>SVG test</text>\n",
          new_str: "<path d=\"M0 4 C 8 0 16 8 24 4\" />\n<text>SVG edited</text>\n",
        }),
      }),
    ]);

    expect(summary).toMatchObject({
      added: 2,
      removed: 1,
      files: [{ filePath: "simple-wave.svg", added: 2, removed: 1 }],
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
    expect(summary?.files[0].previewLines).toMatchObject([
      { type: "removed", content: "old" },
      { type: "added", content: "new" },
      { type: "added", content: "next" },
    ]);
  });

  it("detects apply_patch content inside shell command tools", () => {
    const summary = summarizeTurnEdits([
      activity({
        toolName: "Bash",
        inputJson: JSON.stringify({
          command: [
            "apply_patch <<'PATCH'",
            "*** Begin Patch",
            "*** Update File: src/ui/App.tsx",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
            "PATCH",
          ].join("\n"),
        }),
      }),
    ]);

    expect(summary).toMatchObject({
      added: 1,
      removed: 1,
      files: [{ filePath: "src/ui/App.tsx", added: 1, removed: 1 }],
    });
  });

  it("summarizes Codex fileChange tool inputs through the patch parser", () => {
    const summary = summarizeTurnEdits([
      activity({
        toolName: "Edit",
        inputJson: JSON.stringify({
          changes: [
            {
              path: "src/ui/App.tsx",
              kind: "update",
              diff: [
                "@@ -1,2 +1,3 @@",
                " import React from \"react\";",
                "-const label = \"old\";",
                "+const label = \"new\";",
                "+const enabled = true;",
              ].join("\n"),
            },
            {
              path: "src/main.rs",
              kind: "add",
              diff: ["@@ -0,0 +1,2 @@", "+fn main() {", "+}"].join("\n"),
            },
          ],
        }),
      }),
    ]);

    expect(summary).toMatchObject({
      added: 4,
      removed: 1,
      files: [
        { filePath: "src/main.rs", added: 2, removed: 0 },
        { filePath: "src/ui/App.tsx", added: 2, removed: 1 },
      ],
    });
    expect(summary?.files[1].previewLines).toMatchObject([
      { type: "context", content: "import React from \"react\";" },
      { type: "removed", content: "const label = \"old\";" },
      { type: "added", content: "const label = \"new\";" },
      { type: "added", content: "const enabled = true;" },
    ]);
  });

  it("summarizes workspace diff files and builds lazy preview lines", () => {
    const summary = summarizeDiffFiles([
      { path: "src/app.ts", status: "Modified", additions: 4, deletions: 1 },
      { path: "src/empty.ts", status: "Added" },
    ]);

    expect(summary).toMatchObject({
      added: 4,
      removed: 1,
      files: [
        { filePath: "src/app.ts", added: 4, removed: 1, previewLines: [] },
        { filePath: "src/empty.ts", added: 0, removed: 0, previewLines: [] },
      ],
    });

    expect(
      previewLinesFromFileDiff({
        path: "src/app.ts",
        is_binary: false,
        hunks: [
          {
            old_start: 2,
            new_start: 2,
            header: "@@ -2 +2 @@",
            lines: [
              {
                line_type: "Context",
                old_line_number: 2,
                new_line_number: 2,
                content: "same",
              },
              {
                line_type: "Removed",
                old_line_number: 3,
                new_line_number: null,
                content: "old",
              },
              {
                line_type: "Added",
                old_line_number: null,
                new_line_number: 3,
                content: "new",
              },
            ],
          },
        ],
      }),
    ).toMatchObject([
      { type: "context", content: "same" },
      { type: "removed", content: "old" },
      { type: "added", content: "new" },
    ]);
  });
});
