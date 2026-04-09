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

describe("agentQuestion lifecycle (per-workspace)", () => {
  beforeEach(() => {
    useAppStore.setState({
      agentQuestions: {},
      toolActivities: {},
      completedTurns: {},
      chatMessages: {},
    });
  });

  it("setAgentQuestion stores question keyed by workspace", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);
    expect(useAppStore.getState().agentQuestions[WS_ID]).toEqual(q);
  });

  it("clearAgentQuestion removes question for that workspace only", () => {
    useAppStore.getState().setAgentQuestion(makeQuestion(WS_ID));
    useAppStore.getState().setAgentQuestion(makeQuestion("other-ws"));
    useAppStore.getState().clearAgentQuestion(WS_ID);
    expect(useAppStore.getState().agentQuestions[WS_ID]).toBeUndefined();
    expect(useAppStore.getState().agentQuestions["other-ws"]).toBeDefined();
  });

  it("finalizeTurn does NOT clear agentQuestions", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);
    addToolActivities();

    useAppStore.getState().finalizeTurn(WS_ID, 1);

    expect(useAppStore.getState().toolActivities[WS_ID]).toEqual([]);
    expect(useAppStore.getState().completedTurns[WS_ID]).toHaveLength(1);
    expect(useAppStore.getState().agentQuestions[WS_ID]).toEqual(q);
  });

  it("agentQuestion persists across multiple finalizeTurn calls", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);

    useAppStore.getState().finalizeTurn(WS_ID, 0);
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    expect(useAppStore.getState().agentQuestions[WS_ID]).toEqual(q);
  });

  it("questions are isolated per workspace", () => {
    const qa = makeQuestion("ws-a");
    const qb = makeQuestion("ws-b");
    useAppStore.getState().setAgentQuestion(qa);
    useAppStore.getState().setAgentQuestion(qb);

    expect(useAppStore.getState().agentQuestions["ws-a"]).toEqual(qa);
    expect(useAppStore.getState().agentQuestions["ws-b"]).toEqual(qb);
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
    useAppStore.setState({
      chatMessages: { [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "" }] },
    });
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

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
