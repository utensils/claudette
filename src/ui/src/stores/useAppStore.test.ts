import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { AgentQuestion } from "./useAppStore";

const WS_ID = "test-workspace";

function makeQuestion(wsId: string = WS_ID): AgentQuestion {
  return {
    workspaceId: wsId,
    toolUseId: "tool-1",
    questions: [
      {
        question: "Pick a framework",
        options: [{ label: "React" }, { label: "Vue" }],
      },
    ],
  };
}

function addToolActivities(wsId: string = WS_ID) {
  useAppStore.setState({
    toolActivities: {
      [wsId]: [
        {
          toolUseId: "tool-1",
          toolName: "AskUserQuestion",
          inputJson: "{}",
          resultText: "",
          collapsed: true,
          summary: "",
        },
      ],
    },
  });
}

describe("agentQuestion lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({
      agentQuestion: null,
      toolActivities: {},
      completedTurns: {},
      chatMessages: {},
    });
  });

  it("setAgentQuestion stores and retrieves the question", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);
    expect(useAppStore.getState().agentQuestion).toEqual(q);
  });

  it("setAgentQuestion(null) clears the question", () => {
    useAppStore.getState().setAgentQuestion(makeQuestion());
    useAppStore.getState().setAgentQuestion(null);
    expect(useAppStore.getState().agentQuestion).toBeNull();
  });

  it("finalizeTurn does NOT clear agentQuestion", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);
    addToolActivities();

    useAppStore.getState().finalizeTurn(WS_ID, 1);

    expect(useAppStore.getState().toolActivities[WS_ID]).toEqual([]);
    expect(useAppStore.getState().completedTurns[WS_ID]).toHaveLength(1);
    expect(useAppStore.getState().agentQuestion).toEqual(q);
  });

  it("agentQuestion persists across multiple finalizeTurn calls", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);

    useAppStore.getState().finalizeTurn(WS_ID, 0);
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    expect(useAppStore.getState().agentQuestion).toEqual(q);
  });

  it("question is scoped to workspace", () => {
    const q = makeQuestion("other-workspace");
    useAppStore.getState().setAgentQuestion(q);

    const stored = useAppStore.getState().agentQuestion;
    expect(stored?.workspaceId).toBe("other-workspace");
    expect(stored?.workspaceId).not.toBe(WS_ID);
  });
});

describe("finalizeTurn afterMessageIndex", () => {
  beforeEach(() => {
    useAppStore.setState({
      toolActivities: {},
      completedTurns: {},
      chatMessages: {},
    });
  });

  it("records afterMessageIndex as current chatMessages length", () => {
    // Simulate 2 messages already in the chat.
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "User", content: "hi", cost_usd: null, duration_ms: null, created_at: "" },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "hello", cost_usd: null, duration_ms: null, created_at: "" },
        ],
      },
    });
    addToolActivities();

    useAppStore.getState().finalizeTurn(WS_ID, 1);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].afterMessageIndex).toBe(2);
  });

  it("records 0 when no messages exist", () => {
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns[0].afterMessageIndex).toBe(0);
  });

  it("successive turns get increasing afterMessageIndex", () => {
    // Turn 1: finalize with 1 message
    useAppStore.setState({
      chatMessages: { [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "" }] },
    });
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    // Turn 2: add user + assistant messages, then finalize with new tools
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "" },
          { id: "m2", workspace_id: WS_ID, role: "User", content: "b", cost_usd: null, duration_ms: null, created_at: "" },
          { id: "m3", workspace_id: WS_ID, role: "Assistant", content: "c", cost_usd: null, duration_ms: null, created_at: "" },
        ],
      },
    });
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(2);
    expect(turns[0].afterMessageIndex).toBe(1);
    expect(turns[1].afterMessageIndex).toBe(3);
  });
});
