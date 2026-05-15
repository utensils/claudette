import { describe, expect, it } from "vitest";

import { parseCodexApproval } from "./useAgentStream";

describe("parseCodexApproval — Pi file-change details", () => {
  it("surfaces operation, oldText, newText, and reason for Pi edit approvals", () => {
    // Regression: Pi's `edit` tool sends `operation` / `oldText` /
    // `newText` on every approval payload, but `parseCodexApproval`
    // previously only extracted `path` + `reason`, so the user had to
    // approve a mutation without ever seeing the proposed diff —
    // defeating the audit purpose of the prompt.
    const approval = parseCodexApproval(
      "chat-1",
      "tool-use-1",
      "CodexFileChangeApproval",
      {
        codexApprovalKind: "fileChange",
        codexMethod: "pi/tool/requestApproval",
        path: "/repo/src/app.ts",
        operation: "edit",
        oldText: "const x = 1;",
        newText: "const x = 2;",
        reason: "Pi requested a file edit.",
      },
    );
    expect(approval).not.toBeNull();
    expect(approval!.kind).toBe("fileChange");
    const labelMap = new Map(
      approval!.details.map((d) => [d.labelKey, d.value]),
    );
    expect(labelMap.get("path")).toBe("/repo/src/app.ts");
    expect(labelMap.get("operation")).toBe("edit");
    expect(labelMap.get("oldText")).toBe("const x = 1;");
    expect(labelMap.get("newText")).toBe("const x = 2;");
    expect(labelMap.get("reason")).toBe("Pi requested a file edit.");
  });

  it("surfaces only newText for Pi write approvals (no oldText)", () => {
    // The `write` tool replaces (or creates) a file's full contents, so
    // there's no `oldText` to display. `addDetail` drops empty values,
    // which keeps the card free of an `Replacing: ""` row that would
    // otherwise read as a sentinel meaning "empty file".
    const approval = parseCodexApproval(
      "chat-1",
      "tool-use-1",
      "CodexFileChangeApproval",
      {
        codexApprovalKind: "fileChange",
        codexMethod: "pi/tool/requestApproval",
        path: "/repo/new.ts",
        operation: "write",
        newText: "export const created = true;\n",
        reason: "Pi requested a file write.",
      },
    );
    expect(approval).not.toBeNull();
    const labels = approval!.details.map((d) => d.labelKey);
    expect(labels).toContain("operation");
    expect(labels).toContain("newText");
    expect(labels).not.toContain("oldText");
  });

  it("keeps Codex file-change approvals unchanged (no operation/oldText/newText fields)", () => {
    // Codex's own `CodexFileChangeApproval` payload only carries
    // `path` + `reason`. The new extractor uses `addDetail`'s
    // drop-empty behavior so the existing Codex flow renders exactly
    // as before — guard the existing contract against regression.
    const approval = parseCodexApproval(
      "chat-1",
      "tool-use-1",
      "CodexFileChangeApproval",
      {
        codexApprovalKind: "fileChange",
        path: "/repo/app.ts",
        reason: "Codex wants to edit this file.",
      },
    );
    expect(approval).not.toBeNull();
    const labels = approval!.details.map((d) => d.labelKey);
    expect(labels).toEqual(["path", "reason"]);
  });
});
