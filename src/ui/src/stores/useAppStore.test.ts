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

describe("agentQuestion lifecycle", () => {
  beforeEach(() => {
    // Reset store between tests.
    useAppStore.setState({
      agentQuestion: null,
      toolActivities: {},
      completedTurns: {},
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
    // Set up a pending question and some tool activities.
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);
    useAppStore.setState({
      toolActivities: {
        [WS_ID]: [
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

    // Finalize the turn — this is what "result" event triggers.
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    // Tool activities should be cleared and moved to completedTurns.
    expect(useAppStore.getState().toolActivities[WS_ID]).toEqual([]);
    expect(useAppStore.getState().completedTurns[WS_ID]).toHaveLength(1);

    // But the question must survive — it's awaiting user input.
    expect(useAppStore.getState().agentQuestion).toEqual(q);
  });

  it("agentQuestion persists across multiple finalizeTurn calls", () => {
    const q = makeQuestion();
    useAppStore.getState().setAgentQuestion(q);

    // Simulate ProcessExited calling finalizeTurn again (idempotent).
    useAppStore.getState().finalizeTurn(WS_ID, 0);
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    expect(useAppStore.getState().agentQuestion).toEqual(q);
  });

  it("question is scoped to workspace", () => {
    const q = makeQuestion("other-workspace");
    useAppStore.getState().setAgentQuestion(q);

    // Question for a different workspace should not be visible for WS_ID.
    const stored = useAppStore.getState().agentQuestion;
    expect(stored?.workspaceId).toBe("other-workspace");
    expect(stored?.workspaceId).not.toBe(WS_ID);
  });
});
