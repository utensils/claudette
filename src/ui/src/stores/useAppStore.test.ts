import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { AgentQuestion } from "./useAppStore";
import type { ConversationCheckpoint } from "../types/checkpoint";
import { applyPlanModeMountDefault } from "../components/chat/applyPlanModeMountDefault";

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

describe("plugin settings routing", () => {
  beforeEach(() => {
    useAppStore.setState({
      pluginManagementEnabled: true,
      settingsOpen: false,
      settingsSection: null,
      pluginSettingsTab: "installed",
      pluginSettingsRepoId: null,
      pluginSettingsIntent: null,
      pluginRefreshToken: 0,
    });
  });

  it("openPluginSettings opens settings and stores the merged intent", () => {
    useAppStore.getState().openPluginSettings({
      action: "install",
      repoId: "repo-1",
      scope: "project",
      source: "demo@market",
      tab: "installed",
    });

    const state = useAppStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsSection).toBe("plugins");
    expect(state.pluginSettingsTab).toBe("installed");
    expect(state.pluginSettingsRepoId).toBe("repo-1");
    expect(state.pluginSettingsIntent).toEqual({
      action: "install",
      repoId: "repo-1",
      scope: "project",
      source: "demo@market",
      tab: "installed",
      target: null,
    });
  });

  it("openPluginSettings defaults repo context to global when none is provided", () => {
    useAppStore.setState({
      pluginSettingsRepoId: "repo-stale",
      pluginSettingsTab: "installed",
    });

    useAppStore.getState().openPluginSettings({
      tab: "available",
    });

    const state = useAppStore.getState();
    expect(state.pluginSettingsRepoId).toBeNull();
    expect(state.pluginSettingsIntent).toEqual({
      action: null,
      repoId: null,
      scope: "user",
      source: null,
      tab: "available",
      target: null,
    });
  });

  it("manual plugins settings entry resets to global available view", () => {
    useAppStore.setState({
      pluginSettingsRepoId: "repo-1",
      pluginSettingsIntent: {
        action: "install",
        repoId: "repo-1",
        scope: "project",
        source: "demo@market",
        tab: "installed",
        target: null,
      },
      pluginSettingsTab: "installed",
    });

    useAppStore.getState().setSettingsSection("plugins");

    const state = useAppStore.getState();
    expect(state.settingsSection).toBe("plugins");
    expect(state.pluginSettingsRepoId).toBeNull();
    expect(state.pluginSettingsIntent).toBeNull();
    expect(state.pluginSettingsTab).toBe("available");
  });

  it("defaults plugin management to disabled", () => {
    useAppStore.setState({ pluginManagementEnabled: false });
    expect(useAppStore.getState().pluginManagementEnabled).toBe(false);
  });

  it("redirects plugin settings section to experimental when disabled", () => {
    useAppStore.setState({ pluginManagementEnabled: false });

    useAppStore.getState().setSettingsSection("plugins");

    const state = useAppStore.getState();
    expect(state.settingsSection).toBe("experimental");
    expect(state.pluginSettingsIntent).toBeNull();
    expect(state.pluginSettingsRepoId).toBeNull();
  });

  it("ignores openPluginSettings when plugin management is disabled", () => {
    useAppStore.setState({ pluginManagementEnabled: false });

    useAppStore.getState().openPluginSettings({
      action: "install",
      repoId: "repo-1",
      scope: "project",
      source: "demo@market",
      tab: "available",
    });

    const state = useAppStore.getState();
    expect(state.settingsOpen).toBe(false);
    expect(state.settingsSection).toBeNull();
    expect(state.pluginSettingsIntent).toBeNull();
  });

  it("bumpPluginRefreshToken increments monotonically", () => {
    useAppStore.getState().bumpPluginRefreshToken();
    useAppStore.getState().bumpPluginRefreshToken();
    expect(useAppStore.getState().pluginRefreshToken).toBe(2);
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

describe("applyPlanModeMountDefault", () => {
  // ChatToolbar delegates its mount-time "apply global default" step to this
  // helper. The contract: only touch the store if the runtime value is
  // undefined; a remount (workspace swap, remote reconnect, HMR) must not
  // clobber an agent-driven clear of planMode.
  beforeEach(() => {
    useAppStore.setState({ planMode: {} });
  });

  it("applies default when store has no runtime value", () => {
    applyPlanModeMountDefault(WS_ID, true);
    expect(useAppStore.getState().planMode[WS_ID]).toBe(true);
  });

  it("preserves existing false runtime value on remount", () => {
    useAppStore.getState().setPlanMode(WS_ID, false);
    applyPlanModeMountDefault(WS_ID, true);
    expect(useAppStore.getState().planMode[WS_ID]).toBe(false);
  });

  it("preserves existing true runtime value on remount", () => {
    useAppStore.getState().setPlanMode(WS_ID, true);
    applyPlanModeMountDefault(WS_ID, false);
    expect(useAppStore.getState().planMode[WS_ID]).toBe(true);
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
          { id: "m1", workspace_id: WS_ID, role: "User", content: "hi", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "hello", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
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

  it("stores durationMs when provided", () => {
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1, undefined, 12_345);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBe(12_345);
  });

  it("leaves durationMs undefined when not provided", () => {
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    const turns = useAppStore.getState().completedTurns[WS_ID];
    expect(turns[0].durationMs).toBeUndefined();
  });

  it("successive turns get increasing afterMessageIndex", () => {
    useAppStore.setState({
      chatMessages: { [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }] },
    });
    addToolActivities();
    useAppStore.getState().finalizeTurn(WS_ID, 1);

    useAppStore.setState({
      chatMessages: {
        [WS_ID]: [
          { id: "m1", workspace_id: WS_ID, role: "Assistant", content: "a", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m2", workspace_id: WS_ID, role: "User", content: "b", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m3", workspace_id: WS_ID, role: "Assistant", content: "c", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
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
          { id: "m1", workspace_id: WS_ID, role: "User", content: "hi", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "hello", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
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
          { id: "m1", workspace_id: WS_ID, role: "User", content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m2", workspace_id: WS_ID, role: "Assistant", content: "a1", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m3", workspace_id: WS_ID, role: "User", content: "q2", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          { id: "m4", workspace_id: WS_ID, role: "Assistant", content: "a2", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
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
      { id: "m1", workspace_id: WS_ID, role: "User" as const, content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
      { id: "m2", workspace_id: WS_ID, role: "Assistant" as const, content: "a1", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
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
        [WS_ID]: [{ id: "m1", workspace_id: WS_ID, role: "User", content: "q1", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }],
        [OTHER_WS]: [{ id: "m2", workspace_id: OTHER_WS, role: "User", content: "q2", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }],
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

describe("mergeRemoteData / clearRemoteData default branches", () => {
  beforeEach(() => {
    useAppStore.setState({
      repositories: [],
      workspaces: [],
      defaultBranches: {},
    });
  });

  function makeRemotePayload(overrides: Partial<{
    repoId: string;
    defaultBranches: Record<string, string>;
  }> = {}) {
    const repoId = overrides.repoId ?? "remote-repo-1";
    return {
      repositories: [
        {
          id: repoId,
          path: "/srv/claudette",
          name: "claudette-server",
          path_slug: "claudette",
          icon: null,
          created_at: "",
          setup_script: null,
          custom_instructions: null,
          sort_order: 0,
          branch_rename_preferences: null,
          setup_script_auto_run: false,
          path_valid: true,
          remote_connection_id: null,
        },
      ],
      workspaces: [],
      worktree_base_dir: "/srv/wt",
      default_branches: overrides.defaultBranches ?? { [repoId]: "origin/main" },
      last_messages: [],
    };
  }

  it("merges remote default_branches into defaultBranches so review commands can use them", () => {
    useAppStore.getState().mergeRemoteData("conn-1", makeRemotePayload());
    expect(useAppStore.getState().defaultBranches["remote-repo-1"]).toBe("origin/main");
  });

  it("preserves local repo defaultBranches when remote data merges", () => {
    useAppStore.setState({ defaultBranches: { "local-repo": "origin/main" } });
    useAppStore.getState().mergeRemoteData("conn-1", makeRemotePayload());
    const defaults = useAppStore.getState().defaultBranches;
    expect(defaults["local-repo"]).toBe("origin/main");
    expect(defaults["remote-repo-1"]).toBe("origin/main");
  });

  it("overwrites stale defaultBranches for the same repo id on re-merge", () => {
    useAppStore.getState().mergeRemoteData(
      "conn-1",
      makeRemotePayload({ defaultBranches: { "remote-repo-1": "origin/old" } }),
    );
    useAppStore.getState().mergeRemoteData(
      "conn-1",
      makeRemotePayload({ defaultBranches: { "remote-repo-1": "origin/new" } }),
    );
    expect(useAppStore.getState().defaultBranches["remote-repo-1"]).toBe("origin/new");
  });

  it("prunes defaultBranches for repos removed from a new remote payload (prev-repo-id based pruning)", () => {
    // Seed connection with two remote repos.
    useAppStore.getState().mergeRemoteData("conn-1", {
      repositories: [
        {
          id: "remote-repo-1",
          path: "/srv/a",
          name: "a",
          path_slug: "a",
          icon: null,
          created_at: "",
          setup_script: null,
          custom_instructions: null,
          sort_order: 0,
          branch_rename_preferences: null,
          setup_script_auto_run: false,
          path_valid: true,
          remote_connection_id: null,
        },
        {
          id: "remote-repo-2",
          path: "/srv/b",
          name: "b",
          path_slug: "b",
          icon: null,
          created_at: "",
          setup_script: null,
          custom_instructions: null,
          sort_order: 0,
          branch_rename_preferences: null,
          setup_script_auto_run: false,
          path_valid: true,
          remote_connection_id: null,
        },
      ],
      workspaces: [],
      worktree_base_dir: "/srv",
      default_branches: {
        "remote-repo-1": "origin/main",
        "remote-repo-2": "origin/main",
      },
      last_messages: [],
    });
    expect(useAppStore.getState().defaultBranches["remote-repo-2"]).toBe("origin/main");

    // Re-merge with only remote-repo-1. remote-repo-2 must disappear from both
    // repositories and defaultBranches — otherwise stale defaults linger.
    useAppStore.getState().mergeRemoteData("conn-1", makeRemotePayload({ repoId: "remote-repo-1" }));
    const state = useAppStore.getState();
    expect(state.repositories.find((r) => r.id === "remote-repo-2")).toBeUndefined();
    expect(state.defaultBranches["remote-repo-2"]).toBeUndefined();
    expect(state.defaultBranches["remote-repo-1"]).toBe("origin/main");
  });

  it("clearRemoteData drops defaultBranches for the disconnected connection's repos", () => {
    useAppStore.getState().mergeRemoteData("conn-1", makeRemotePayload());
    useAppStore.setState((s) => ({ defaultBranches: { ...s.defaultBranches, "local-repo": "origin/main" } }));
    useAppStore.getState().clearRemoteData("conn-1");
    const defaults = useAppStore.getState().defaultBranches;
    expect(defaults["remote-repo-1"]).toBeUndefined();
    expect(defaults["local-repo"]).toBe("origin/main");
  });
});

describe("finalizeTurn token counts", () => {
  beforeEach(() => {
    useAppStore.setState({
      completedTurns: {},
      toolActivities: {
        // finalizeTurn early-returns if toolActivities is empty, so seed one.
        ws1: [
          {
            toolUseId: "t1",
            toolName: "Bash",
            inputJson: "{}",
            resultText: "",
            collapsed: true,
            summary: "",
          },
        ],
      },
    });
  });

  it("records input/output AND cache tokens on the completed turn", () => {
    useAppStore.getState().finalizeTurn(
      "ws1", 1, "turn-1", 1234, 1500, 240, 80_000, 1_200,
    );
    const turns = useAppStore.getState().completedTurns.ws1 || [];
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBe(1234);
    expect(turns[0].inputTokens).toBe(1500);
    expect(turns[0].outputTokens).toBe(240);
    expect(turns[0].cacheReadTokens).toBe(80_000);
    expect(turns[0].cacheCreationTokens).toBe(1_200);
  });

  it("leaves cache tokens undefined when omitted", () => {
    useAppStore.getState().finalizeTurn(
      "ws1", 1, "turn-2", 500, 100, 50,
    );
    const turns = useAppStore.getState().completedTurns.ws1 || [];
    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBe(100);
    expect(turns[0].outputTokens).toBe(50);
    expect(turns[0].cacheReadTokens).toBeUndefined();
    expect(turns[0].cacheCreationTokens).toBeUndefined();
  });

  it("leaves all token fields undefined when none provided", () => {
    useAppStore.getState().finalizeTurn("ws1", 1, "turn-3", 500);
    const turns = useAppStore.getState().completedTurns.ws1 || [];
    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBeUndefined();
    expect(turns[0].outputTokens).toBeUndefined();
    expect(turns[0].cacheReadTokens).toBeUndefined();
    expect(turns[0].cacheCreationTokens).toBeUndefined();
  });

  it("writes latestTurnUsage alongside the CompletedTurn when tokens are provided", () => {
    useAppStore.getState().finalizeTurn(
      "ws1", 1, "turn-4", 1000, 1500, 240, 80_000, 1_200,
    );
    const usage = useAppStore.getState().latestTurnUsage.ws1;
    expect(usage).toEqual({
      inputTokens: 1500,
      outputTokens: 240,
      cacheReadTokens: 80_000,
      cacheCreationTokens: 1_200,
    });
  });
});

describe("finalizeTurn tool-free turn (no activities)", () => {
  beforeEach(() => {
    // NO toolActivities → finalizeTurn will early-return for the timeline,
    // but the meter's latestTurnUsage slice must still refresh.
    useAppStore.setState({
      completedTurns: {},
      toolActivities: {},
      latestTurnUsage: {},
    });
  });

  it("updates latestTurnUsage even when no tool activities exist", () => {
    useAppStore.getState().finalizeTurn(
      "ws1", 1, "turn-x", 800, 500, 60, 20_000, 300,
    );
    // No CompletedTurn was appended — the timeline stays unchanged.
    expect(useAppStore.getState().completedTurns.ws1).toBeUndefined();
    // But latestTurnUsage IS updated so the ContextMeter can re-render.
    expect(useAppStore.getState().latestTurnUsage.ws1).toEqual({
      inputTokens: 500,
      outputTokens: 60,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 300,
    });
  });

  it("preserves existing latestTurnUsage when finalizeTurn has no token data", () => {
    // Seed a previous turn's usage.
    useAppStore.setState({
      latestTurnUsage: {
        ws1: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 200,
        },
      },
    });
    // Finalize a turn with no usage payload (rare but possible on a broken stream).
    useAppStore.getState().finalizeTurn("ws1", 1, "turn-y", 500);
    // Previous usage stays intact — we never want to stomp a real value with
    // an all-undefined record.
    expect(useAppStore.getState().latestTurnUsage.ws1).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10_000,
      cacheCreationTokens: 200,
    });
  });
});

describe("hydrateCompletedTurns seeds latestTurnUsage", () => {
  beforeEach(() => {
    useAppStore.setState({
      completedTurns: {},
      latestTurnUsage: {},
    });
  });

  it("copies the latest hydrated turn's token fields into latestTurnUsage", () => {
    useAppStore.getState().hydrateCompletedTurns("ws1", [
      {
        id: "cp1",
        activities: [],
        messageCount: 1,
        collapsed: true,
        afterMessageIndex: 2,
        durationMs: 1000,
        inputTokens: 500,
        outputTokens: 100,
      },
      {
        id: "cp2",
        activities: [],
        messageCount: 1,
        collapsed: true,
        afterMessageIndex: 4,
        durationMs: 2000,
        inputTokens: 2000,
        outputTokens: 150,
        cacheReadTokens: 50_000,
        cacheCreationTokens: 800,
      },
    ]);
    // cp2 is the most recent — its tokens should seed the meter.
    expect(useAppStore.getState().latestTurnUsage.ws1).toEqual({
      inputTokens: 2000,
      outputTokens: 150,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 800,
    });
  });

  it("leaves latestTurnUsage untouched when hydrated turns have no token data", () => {
    useAppStore.getState().hydrateCompletedTurns("ws1", [
      {
        id: "cp1",
        activities: [],
        messageCount: 1,
        collapsed: true,
        afterMessageIndex: 2,
      },
    ]);
    expect(useAppStore.getState().latestTurnUsage.ws1).toBeUndefined();
  });
});
