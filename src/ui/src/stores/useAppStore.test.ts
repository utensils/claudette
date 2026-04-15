import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { AgentQuestion } from "./useAppStore";
import type { ConversationCheckpoint } from "../types/checkpoint";

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

describe("effortLevel (per-workspace)", () => {
  beforeEach(() => {
    useAppStore.setState({ effortLevel: {} });
  });

  it("defaults to empty (no explicit effort)", () => {
    expect(useAppStore.getState().effortLevel[WS_ID]).toBeUndefined();
  });

  it("setEffortLevel stores level keyed by workspace", () => {
    useAppStore.getState().setEffortLevel(WS_ID, "high");
    expect(useAppStore.getState().effortLevel[WS_ID]).toBe("high");
  });

  it("effort levels are isolated per workspace", () => {
    useAppStore.getState().setEffortLevel("ws-a", "low");
    useAppStore.getState().setEffortLevel("ws-b", "max");
    expect(useAppStore.getState().effortLevel["ws-a"]).toBe("low");
    expect(useAppStore.getState().effortLevel["ws-b"]).toBe("max");
  });

  it("overwrites previous level for same workspace", () => {
    useAppStore.getState().setEffortLevel(WS_ID, "low");
    useAppStore.getState().setEffortLevel(WS_ID, "high");
    expect(useAppStore.getState().effortLevel[WS_ID]).toBe("high");
  });
});

describe("streamingThinking (per-workspace)", () => {
  beforeEach(() => {
    useAppStore.setState({ streamingThinking: {}, showThinkingBlocks: {} });
  });

  it("appendStreamingThinking accumulates text", () => {
    useAppStore.getState().appendStreamingThinking(WS_ID, "Let me ");
    useAppStore.getState().appendStreamingThinking(WS_ID, "think...");
    expect(useAppStore.getState().streamingThinking[WS_ID]).toBe("Let me think...");
  });

  it("clearStreamingThinking resets to empty", () => {
    useAppStore.getState().appendStreamingThinking(WS_ID, "some thinking");
    useAppStore.getState().clearStreamingThinking(WS_ID);
    expect(useAppStore.getState().streamingThinking[WS_ID]).toBe("");
  });

  it("thinking is isolated per workspace", () => {
    useAppStore.getState().appendStreamingThinking("ws-a", "alpha");
    useAppStore.getState().appendStreamingThinking("ws-b", "beta");
    expect(useAppStore.getState().streamingThinking["ws-a"]).toBe("alpha");
    expect(useAppStore.getState().streamingThinking["ws-b"]).toBe("beta");
  });

  it("setShowThinkingBlocks stores preference", () => {
    useAppStore.getState().setShowThinkingBlocks(WS_ID, false);
    expect(useAppStore.getState().showThinkingBlocks[WS_ID]).toBe(false);
  });

  it("showThinkingBlocks defaults to undefined (treated as false/off)", () => {
    expect(useAppStore.getState().showThinkingBlocks[WS_ID]).toBeUndefined();
  });
});

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

  it("uses the checkpoint id provided by the stream lifecycle", () => {
    addToolActivities();

    useAppStore.getState().finalizeTurn(WS_ID, 1, "cp-new");

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe("cp-new");
  });

  it("defaults completed turn to collapsed", () => {
    addToolActivities();

    useAppStore.getState().finalizeTurn(WS_ID, 1);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].collapsed).toBe(true);
  });

  it("records afterMessageIndex as current chatMessages length", () => {
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "User", content: "hi", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "hello", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
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
      chatMessages: { [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "", thinking: null }] },
    });
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m2", workspace_id: WS_ID, role: "User", content: "b", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m3", workspace_id: WS_ID, role: "Assistant", content: "c", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
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

describe("hydrateCompletedTurns", () => {
  beforeEach(() => {
    useAppStore.setState({
      completedTurns: {},
      toolActivities: {},
      chatMessages: {},
    });
  });

  it("preserves an in-memory turn when DB hydration is stale", () => {
    useAppStore.setState({
      completedTurns: {
        [WS_ID]: [
          {
            id: "cp-new",
            activities: [
              {
                toolUseId: "tool-1",
                toolName: "Read",
                inputJson: "{}",
                resultText: "ok",
                collapsed: true,
                summary: "latest",
              },
            ],
            messageCount: 2,
            collapsed: false,
            afterMessageIndex: 4,
          },
        ],
      },
    });

    useAppStore.getState().hydrateCompletedTurns(WS_ID, []);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe("cp-new");
  });

  it("merges persisted data into the existing turn without duplicating it", () => {
    useAppStore.setState({
      completedTurns: {
        [WS_ID]: [
          {
            id: "cp1",
            activities: [
              {
                toolUseId: "tool-1",
                toolName: "Read",
                inputJson: "{}",
                resultText: "old",
                collapsed: false,
                summary: "old summary",
              },
            ],
            messageCount: 1,
            collapsed: true,
            afterMessageIndex: 2,
          },
        ],
      },
    });

    useAppStore.getState().hydrateCompletedTurns(WS_ID, [
      {
        id: "cp1",
        activities: [
          {
            toolUseId: "tool-1",
            toolName: "Read",
            inputJson: '{"path":"src/lib.rs"}',
            resultText: "new",
            collapsed: true,
            summary: "new summary",
          },
        ],
        messageCount: 3,
        collapsed: false,
        afterMessageIndex: 2,
      },
    ]);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].collapsed).toBe(true);
    expect(turns[0].messageCount).toBe(3);
    expect(turns[0].activities[0].resultText).toBe("new");
    expect(turns[0].activities[0].collapsed).toBe(false);
  });
});

describe("finalizeTurn double-call guard", () => {
  beforeEach(() => {
    useAppStore.setState({
      toolActivities: {},
      completedTurns: {},
      chatMessages: {},
    });
  });

  it("second finalizeTurn is a no-op when activities were already cleared", () => {
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 2);

    // Simulate ProcessExited firing after result already finalized.
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].messageCount).toBe(2);
  });

  it("does not create a phantom turn with 0 activities", () => {
    // No tool activities at all — finalizeTurn should be a no-op.
    useAppStore.getState().finalizeTurn(WS_ID, 5);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toBeUndefined();
  });

  it("preserves first turn's message count on double finalize", () => {
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "User", content: "hi", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "hello", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
        ],
      },
    });
    addToolActivities();

    // First call (from result event): correct message count.
    useAppStore.getState().finalizeTurn(WS_ID, 3);
    // Second call (from ProcessExited): different count — should be ignored.
    useAppStore.getState().finalizeTurn(WS_ID, 0);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].messageCount).toBe(3);
    expect(turns[0].afterMessageIndex).toBe(2);
  });
});

// --- Checkpoint tests ---

function makeCheckpoint(
  id: string,
  wsId: string,
  messageId: string,
  turnIndex: number,
): ConversationCheckpoint {
  return {
    id,
    workspace_id: wsId,
    message_id: messageId,
    commit_hash: `hash-${turnIndex}`,
    has_file_state: false,
    turn_index: turnIndex,
    message_count: 1,
    created_at: "",
  };
}

describe("checkpoint management", () => {
  beforeEach(() => {
    useAppStore.setState({ checkpoints: {} });
  });

  it("setCheckpoints stores checkpoints keyed by workspace", () => {
    const cps = [makeCheckpoint("cp1", WS_ID, "m2", 0)];
    useAppStore.getState().setCheckpoints(WS_ID, cps);
    expect(useAppStore.getState().checkpoints[WS_ID]).toEqual(cps);
  });

  it("addCheckpoint appends to existing list", () => {
    useAppStore.getState().setCheckpoints(WS_ID, [
      makeCheckpoint("cp1", WS_ID, "m2", 0),
    ]);
    useAppStore.getState().addCheckpoint(
      WS_ID,
      makeCheckpoint("cp2", WS_ID, "m4", 1),
    );
    expect(useAppStore.getState().checkpoints[WS_ID]).toHaveLength(2);
    expect(useAppStore.getState().checkpoints[WS_ID][1].id).toBe("cp2");
  });

  it("addCheckpoint creates list when none exists", () => {
    useAppStore.getState().addCheckpoint(
      WS_ID,
      makeCheckpoint("cp1", WS_ID, "m2", 0),
    );
    expect(useAppStore.getState().checkpoints[WS_ID]).toHaveLength(1);
  });
});

describe("rollbackConversation", () => {
  beforeEach(() => {
    useAppStore.setState({
      chatMessages: {},
      completedTurns: {},
      toolActivities: {},
      streamingContent: {},
      agentQuestions: {},
      planApprovals: {},
      checkpoints: {},
    });
  });

  it("replaces chat messages with truncated list", () => {
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "User", content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "a1", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m3", workspace_id: WS_ID, role: "User", content: "q2", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
          { id: "m4", workspace_id: WS_ID, role: "Assistant", content: "a2", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
        ],
      },
      checkpoints: {
        [WS_ID]: [
          makeCheckpoint("cp1", WS_ID, "m2", 0),
          makeCheckpoint("cp2", WS_ID, "m4", 1),
        ],
      },
    });

    // Simulate backend returning truncated messages.
    const truncated = [
      { id: "m1", workspace_id: WS_ID, role: "User" as const, content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
      { id: "m2", workspace_id: WS_ID, role: "Assistant" as const, content: "a1", cost_usd: null, duration_ms: null, created_at: "", thinking: null },
    ];
    useAppStore.getState().rollbackConversation(WS_ID, "cp1", truncated);

    expect(useAppStore.getState().chatMessages[WS_ID]).toEqual(truncated);
  });

  it("clears completedTurns and toolActivities for workspace", () => {
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);
    useAppStore.setState({
      checkpoints: { [WS_ID]: [makeCheckpoint("cp1", WS_ID, "m1", 0)] },
    });

    useAppStore.getState().rollbackConversation(WS_ID, "cp1", []);

    expect(useAppStore.getState().completedTurns[WS_ID]).toEqual([]);
    expect(useAppStore.getState().toolActivities[WS_ID]).toEqual([]);
  });

  it("clears streaming content for workspace", () => {
    useAppStore.setState({
      streamingContent: { [WS_ID]: "some partial text" },
      checkpoints: { [WS_ID]: [makeCheckpoint("cp1", WS_ID, "m1", 0)] },
    });

    useAppStore.getState().rollbackConversation(WS_ID, "cp1", []);

    expect(useAppStore.getState().streamingContent[WS_ID]).toBe("");
  });

  it("trims checkpoints after the target", () => {
    useAppStore.setState({
      checkpoints: {
        [WS_ID]: [
          makeCheckpoint("cp1", WS_ID, "m2", 0),
          makeCheckpoint("cp2", WS_ID, "m4", 1),
          makeCheckpoint("cp3", WS_ID, "m6", 2),
        ],
      },
    });

    useAppStore.getState().rollbackConversation(WS_ID, "cp1", []);

    const remaining = useAppStore.getState().checkpoints[WS_ID];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("cp1");
  });

  it("does not affect other workspaces", () => {
    const OTHER_WS = "other-ws";
    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "User", content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null }],
        [OTHER_WS]: [{ id: "m2", workspace_id: OTHER_WS, role: "User", content: "q2", cost_usd: null, duration_ms: null, created_at: "", thinking: null }],
      },
      checkpoints: {
        [WS_ID]: [makeCheckpoint("cp1", WS_ID, "m1", 0)],
        [OTHER_WS]: [makeCheckpoint("cp2", OTHER_WS, "m2", 0)],
      },
    });

    useAppStore.getState().rollbackConversation(WS_ID, "cp1", []);

    expect(useAppStore.getState().chatMessages[OTHER_WS]).toHaveLength(1);
    expect(useAppStore.getState().checkpoints[OTHER_WS]).toHaveLength(1);
  });
});
