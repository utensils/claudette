import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import type { ChatMessage } from "../../types/chat";
import type { ToolActivity } from "../../stores/useAppStore";
import { findLatestPlanFilePath } from "./planFilePath";

const WS = "ws-plan";

function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    workspace_id: WS,
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
    thinking: null,
  };
}

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: "tu-1",
    toolName: "ExitPlanMode",
    inputJson: "",
    resultText: "",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

beforeEach(() => {
  // Reset the scan inputs this helper reads from. Other slices can stay
  // untouched since findLatestPlanFilePath only looks at these maps.
  useAppStore.setState({
    chatMessages: {},
    streamingContent: {},
    toolActivities: {},
    planApprovals: {},
  });
});

describe("findLatestPlanFilePath", () => {
  it("returns null when the workspace has never surfaced a plan path", () => {
    expect(findLatestPlanFilePath(WS)).toBeNull();
  });

  it("extracts the plan path from a recent chat message", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg("m1", "User", "please plan this"),
          msg(
            "m2",
            "Assistant",
            "Plan written to /Users/alice/.claude/plans/refactor-login.md.",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/Users/alice/.claude/plans/refactor-login.md",
    );
  });

  it("prefers the newest message when multiple messages mention plan paths", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "old plan at /home/dev/.claude/plans/old-plan.md",
          ),
          msg("m2", "User", "approved"),
          msg(
            "m3",
            "Assistant",
            "Plan written to /home/dev/.claude/plans/new-plan.md.",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/home/dev/.claude/plans/new-plan.md",
    );
  });

  it("keeps returning the plan path even after the pending approval is cleared", () => {
    // Simulates the "user approved the plan" state the reporter hit: the
    // PlanApprovalCard clears planApprovals[wsId], but the chat history
    // still carries the plan path, so /plan open must still resolve it.
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "Plan written to /Users/alice/.claude/plans/readme-refresh.md.",
          ),
          msg("m2", "User", "Plan approved. Proceed with implementation."),
        ],
      },
      planApprovals: {}, // cleared after approval
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/Users/alice/.claude/plans/readme-refresh.md",
    );
  });

  it("falls back to the active streaming buffer when no message has landed yet", () => {
    useAppStore.setState({
      streamingContent: {
        [WS]: "Writing Plan written to /tmp/.claude/plans/streaming.md now.",
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe("/tmp/.claude/plans/streaming.md");
  });

  it("falls back to tool activity input/result text", () => {
    useAppStore.setState({
      toolActivities: {
        [WS]: [
          activity({
            toolName: "EnterPlanMode",
            inputJson: JSON.stringify({
              planPath: "/var/work/.claude/plans/enter-plan.md",
            }),
            resultText: "",
          }),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/var/work/.claude/plans/enter-plan.md",
    );
  });

  it("falls back to the pending plan approval's planFilePath as a last resort", () => {
    useAppStore.setState({
      planApprovals: {
        [WS]: {
          workspaceId: WS,
          toolUseId: "tu-approval",
          planFilePath: "/repo/.claude/plans/approval-fallback.md",
          allowedPrompts: [],
        },
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/repo/.claude/plans/approval-fallback.md",
    );
  });

  it("only looks at paths under `.claude/plans/` with a .md extension", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "see /Users/alice/.claude/notes/random.md and /tmp/other.md",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBeNull();
  });

  it("extracts a plan path that contains whitespace (macOS home dirs with spaces)", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "Plan written to /Users/Ada Lovelace/.claude/plans/compiler notes.md.",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/Users/Ada Lovelace/.claude/plans/compiler notes.md",
    );
  });

  it("stops the match at trailing punctuation rather than swallowing following prose", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "See /Users/alice/.claude/plans/final.md, then come back.",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe(
      "/Users/alice/.claude/plans/final.md",
    );
  });

  it("returns the NEWEST tool activity when several activities mention different plans", () => {
    // addToolActivity appends to the end of the array — scan must iterate
    // newest-first so the most recent plan wins when a workspace has produced
    // plans across multiple turns within the same session window.
    useAppStore.setState({
      toolActivities: {
        [WS]: [
          activity({
            toolUseId: "tu-old",
            toolName: "EnterPlanMode",
            resultText: "/repo/.claude/plans/oldest.md",
          }),
          activity({
            toolUseId: "tu-mid",
            toolName: "EnterPlanMode",
            resultText: "/repo/.claude/plans/middle.md",
          }),
          activity({
            toolUseId: "tu-new",
            toolName: "EnterPlanMode",
            resultText: "/repo/.claude/plans/newest.md",
          }),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe("/repo/.claude/plans/newest.md");
  });

  it("ignores paths that do not point under `.claude/plans/` with a .md suffix", () => {
    // Guard the whitespace-allowing regex against overreach: it must still
    // only match the specific plan-file shape.
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "see /Users/alice/.claude/plans/draft.txt or /other/file.md",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBeNull();
  });

  it("scopes results by workspace id — one workspace's plan does not leak to another", () => {
    useAppStore.setState({
      chatMessages: {
        [WS]: [
          msg(
            "m1",
            "Assistant",
            "Plan written to /repo/.claude/plans/a.md.",
          ),
        ],
        "other-ws": [
          msg(
            "m2",
            "Assistant",
            "Plan written to /repo/.claude/plans/b.md.",
          ),
        ],
      },
    });
    expect(findLatestPlanFilePath(WS)).toBe("/repo/.claude/plans/a.md");
    expect(findLatestPlanFilePath("other-ws")).toBe(
      "/repo/.claude/plans/b.md",
    );
    expect(findLatestPlanFilePath("no-ws")).toBeNull();
  });
});
