import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../../types/chat";
import type { CompletedTurn, ToolActivity } from "../../../stores/useAppStore";
import {
  categorizeActivity,
  deriveSessionMetrics,
  deriveTurnDashboard,
  groupMessagesIntoTurns,
  mcpServerLabel,
  turnHasDashboardActivity,
} from "./deriveDashboard";

function makeMsg(
  role: ChatMessage["role"],
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: overrides.id ?? `${role}-${Math.random().toString(36).slice(2)}`,
    workspace_id: "ws",
    chat_session_id: "sess",
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "2026-05-23T00:00:00Z",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    ...overrides,
  };
}

function makeActivity(
  toolName: string,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: overrides.toolUseId ?? `tu-${Math.random().toString(36).slice(2)}`,
    toolName,
    inputJson: overrides.inputJson ?? "{}",
    resultText: overrides.resultText ?? "",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

function makeCompletedTurn(
  activities: ToolActivity[],
  overrides: Partial<CompletedTurn> = {},
): CompletedTurn {
  return {
    id: overrides.id ?? "turn-1",
    activities,
    messageCount: overrides.messageCount ?? 1,
    collapsed: true,
    afterMessageIndex: overrides.afterMessageIndex ?? activities.length,
    ...overrides,
  };
}

describe("categorizeActivity", () => {
  it("maps tool names to coarse categories", () => {
    expect(categorizeActivity("mcp__claudette__send_to_user")).toBe("mcp");
    expect(categorizeActivity("Agent")).toBe("subagent");
    expect(categorizeActivity("Task")).toBe("subagent");
    expect(categorizeActivity("AskUserQuestion")).toBe("question");
    expect(categorizeActivity("ExitPlanMode")).toBe("plan");
    expect(categorizeActivity("Skill")).toBe("skill");
    expect(categorizeActivity("Edit")).toBe("edit");
    expect(categorizeActivity("Write")).toBe("edit");
    expect(categorizeActivity("Read")).toBe("file");
    expect(categorizeActivity("Grep")).toBe("file");
    expect(categorizeActivity("Bash")).toBe("bash");
    expect(categorizeActivity("SomethingElse")).toBe("other");
  });
});

describe("groupMessagesIntoTurns", () => {
  it("splits on user-message boundaries and tracks the final assistant", () => {
    const u1 = makeMsg("User", "first", { id: "u1" });
    const a1 = makeMsg("Assistant", "thinking out loud", { id: "a1" });
    const a2 = makeMsg("Assistant", "final answer one", { id: "a2" });
    const u2 = makeMsg("User", "second", { id: "u2" });
    const a3 = makeMsg("Assistant", "final answer two", { id: "a3" });

    const groups = groupMessagesIntoTurns([u1, a1, a2, u2, a3]);
    expect(groups).toHaveLength(2);

    expect(groups[0].userMessage?.id).toBe("u1");
    expect(groups[0].assistantMessages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(groups[0].finalAssistant?.id).toBe("a2");
    expect(groups[0].endExclusive).toBe(3);

    expect(groups[1].userMessage?.id).toBe("u2");
    expect(groups[1].finalAssistant?.id).toBe("a3");
    expect(groups[1].endExclusive).toBe(5);
  });

  it("collects leading System messages into an orphan group", () => {
    const sys = makeMsg("System", "Conversation cleared.", { id: "s1" });
    const u1 = makeMsg("User", "hi", { id: "u1" });
    const a1 = makeMsg("Assistant", "hello", { id: "a1" });

    const groups = groupMessagesIntoTurns([sys, u1, a1]);
    expect(groups).toHaveLength(2);
    expect(groups[0].userMessage).toBeNull();
    expect(groups[0].systemMessages.map((m) => m.id)).toEqual(["s1"]);
    expect(groups[1].userMessage?.id).toBe("u1");
  });
});

describe("deriveTurnDashboard", () => {
  it("counts thoughts, tool calls, questions, plans, and categories from a completed turn", () => {
    const activities = [
      makeActivity("Read"),
      makeActivity("Read"),
      makeActivity("Edit"),
      makeActivity("Bash"),
      makeActivity("mcp__server__do"),
      makeActivity("AskUserQuestion"),
      makeActivity("ExitPlanMode"),
    ];
    const assistantMessages = [
      makeMsg("Assistant", "let me think", { thinking: "hmm" }),
      makeMsg("Assistant", "done", { thinking: "  " }), // whitespace-only ignored
    ];
    const completedTurn = makeCompletedTurn(activities, {
      durationMs: 4200,
      inputTokens: 1500,
      outputTokens: 600,
    });

    const m = deriveTurnDashboard({ assistantMessages, completedTurn });

    expect(m.thoughts).toBe(1);
    expect(m.toolCalls).toBe(7);
    expect(m.questions).toBe(1);
    expect(m.plans).toBe(1);
    expect(m.byCategory.file).toBe(2);
    expect(m.byCategory.edit).toBe(1);
    expect(m.byCategory.bash).toBe(1);
    expect(m.byCategory.mcp).toBe(1);
    expect(m.durationMs).toBe(4200);
    expect(m.inputTokens).toBe(1500);
    expect(m.outputTokens).toBe(600);
    expect(m.isLive).toBe(false);
    expect(turnHasDashboardActivity(m)).toBe(true);
  });

  it("derives task counts from TodoWrite activity", () => {
    const todo = makeActivity("TodoWrite", {
      inputJson: JSON.stringify({
        todos: [
          { id: "1", content: "a", status: "completed" },
          { id: "2", content: "b", status: "in_progress" },
          { id: "3", content: "c", status: "pending" },
        ],
      }),
    });
    const m = deriveTurnDashboard({
      assistantMessages: [],
      completedTurn: makeCompletedTurn([todo]),
    });
    expect(m.tasks.total).toBe(3);
    expect(m.tasks.completed).toBe(1);
  });

  it("reconstructs duration/tokens from assistant messages for a tool-free turn", () => {
    const assistantMessages = [
      makeMsg("Assistant", "answer", {
        duration_ms: 1200,
        input_tokens: 300,
        output_tokens: 90,
      }),
    ];
    const m = deriveTurnDashboard({ assistantMessages });
    expect(m.toolCalls).toBe(0);
    expect(m.durationMs).toBe(1200);
    expect(m.inputTokens).toBe(300);
    expect(m.outputTokens).toBe(90);
    // No tools, no thoughts → nothing for a dashboard card to show.
    expect(turnHasDashboardActivity(m)).toBe(false);
  });

  it("adds a live thought while thinking is streaming", () => {
    const m = deriveTurnDashboard({
      assistantMessages: [],
      liveActivities: [makeActivity("Bash")],
      liveThinking: "considering options",
      isLive: true,
    });
    expect(m.isLive).toBe(true);
    expect(m.thoughts).toBe(1);
    expect(m.toolCalls).toBe(1);
  });
});

describe("mcpServerLabel", () => {
  it("extracts the server segment from an MCP tool id", () => {
    expect(mcpServerLabel("mcp__github__create_issue")).toBe("github");
    expect(mcpServerLabel("mcp__linear__list_issues")).toBe("linear");
    // Non-standard ids fall back to the de-prefixed name rather than blank.
    expect(mcpServerLabel("mcp__weird")).toBe("weird");
  });
});

describe("deriveSessionMetrics", () => {
  function skill(name: string): ToolActivity {
    return makeActivity("Skill", { inputJson: JSON.stringify({ skill: name }) });
  }

  it("sums totals and counts thinking turns across the session", () => {
    const aActivities = [makeActivity("Read"), makeActivity("Edit")];
    const bActivities = [makeActivity("mcp__github__x")];
    const turnA = {
      metrics: deriveTurnDashboard({
        assistantMessages: [makeMsg("Assistant", "x", { thinking: "t" })],
        completedTurn: makeCompletedTurn(aActivities, {
          inputTokens: 100,
          outputTokens: 50,
        }),
      }),
      activities: aActivities,
    };
    const turnB = {
      metrics: deriveTurnDashboard({
        assistantMessages: [], // no thinking this turn
        completedTurn: makeCompletedTurn(bActivities, {
          inputTokens: 40,
          outputTokens: 20,
        }),
      }),
      activities: bActivities,
    };

    const session = deriveSessionMetrics([turnA, turnB]);
    expect(session.thoughts).toBe(1);
    expect(session.thinkingTurns).toBe(1);
    expect(session.toolCalls).toBe(3);
    expect(session.mcpCalls).toBe(1);
    expect(session.inputTokens).toBe(140);
    expect(session.outputTokens).toBe(70);
  });

  it("builds skill and MCP leaderboards ranked by count", () => {
    const activities = [
      skill("frontend-design"),
      skill("frontend-design"),
      skill("commit-changes"),
      makeActivity("mcp__github__create_issue"),
      makeActivity("mcp__github__list_prs"),
      makeActivity("mcp__github__list_prs"),
      makeActivity("mcp__linear__list"),
    ];
    const turn = {
      metrics: deriveTurnDashboard({
        assistantMessages: [],
        completedTurn: makeCompletedTurn(activities),
      }),
      activities,
    };

    const session = deriveSessionMetrics([turn]);
    expect(session.topSkills).toEqual([
      { name: "frontend-design", count: 2 },
      { name: "commit-changes", count: 1 },
    ]);
    // Grouped by MCP server, descending.
    expect(session.topMcps).toEqual([
      { name: "github", count: 3 },
      { name: "linear", count: 1 },
    ]);
    expect(session.mcpCalls).toBe(4);
  });

  it("caps each leaderboard at five entries", () => {
    const activities = ["a", "b", "c", "d", "e", "f"].map((n) =>
      makeActivity("Skill", { inputJson: JSON.stringify({ skill: n }) }),
    );
    const session = deriveSessionMetrics([
      {
        metrics: deriveTurnDashboard({
          assistantMessages: [],
          completedTurn: makeCompletedTurn(activities),
        }),
        activities,
      },
    ]);
    expect(session.topSkills).toHaveLength(5);
  });
});
