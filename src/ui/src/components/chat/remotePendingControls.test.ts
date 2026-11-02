import { describe, it, expect, beforeEach, vi } from "vitest";

const sendRemoteCommand = vi.hoisted(() => vi.fn());
vi.mock("../../services/tauri", () => ({ sendRemoteCommand }));

import { useAppStore } from "../../stores/useAppStore";
import type { ChatMessage, ChatSession, SessionAgentStatus } from "../../types";
import {
  hydrateRemotePendingControls,
  reconcilePendingControls,
} from "./remotePendingControls";

const SESSION = "remote-session";

function askControl(toolUseId: string) {
  return {
    tool_use_id: toolUseId,
    tool_name: "AskUserQuestion",
    input: { question: "Proceed?", options: ["Yes", "No"] },
  };
}

function cardId(): string | undefined {
  return useAppStore.getState().agentQuestions[SESSION]?.toolUseId;
}

describe("reconcilePendingControls", () => {
  beforeEach(() => {
    useAppStore.setState({
      agentQuestions: {},
      planApprovals: {},
      agentApprovals: {},
      sessionsByWorkspace: {},
    });
  });

  it("shows a prompt that was raised before this window was listening", () => {
    reconcilePendingControls(SESSION, [askControl("t1")], null);
    expect(cardId()).toBe("t1");
  });

  it("clears a card the server no longer has pending", () => {
    reconcilePendingControls(SESSION, [askControl("t1")], null);
    reconcilePendingControls(SESSION, [], "t1");
    expect(cardId()).toBeUndefined();
  });

  it("leaves a card that arrived live after the snapshot was requested", () => {
    reconcilePendingControls(SESSION, [askControl("t2")], null);
    // Snapshot was requested when no card showed; it predates t2.
    reconcilePendingControls(SESSION, [], null);
    expect(cardId()).toBe("t2");
  });

  it("does not restore a card answered while the snapshot was in flight", () => {
    reconcilePendingControls(SESSION, [askControl("t1")], null);
    // Snapshot requested while t1 showed; the user answered before it landed.
    useAppStore.getState().clearAgentQuestion(SESSION);
    reconcilePendingControls(SESSION, [askControl("t1")], "t1");
    expect(cardId()).toBeUndefined();
  });

  it("does not re-apply a card that is already showing", () => {
    reconcilePendingControls(SESSION, [askControl("t1")], null);
    const before = useAppStore.getState().agentQuestions[SESSION];
    reconcilePendingControls(SESSION, [askControl("t1")], "t1");
    expect(useAppStore.getState().agentQuestions[SESSION]).toBe(before);
  });
});

function makeSession(agentStatus: SessionAgentStatus): ChatSession {
  return {
    id: SESSION,
    workspace_id: "remote-ws",
    session_id: null,
    name: "New chat",
    name_edited: false,
    turn_count: 1,
    sort_order: 0,
    status: "Active",
    created_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: agentStatus,
    needs_attention: false,
    attention_kind: null,
  };
}

function makeMessage(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    workspace_id: "remote-ws",
    chat_session_id: SESSION,
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "2026-01-01T00:00:00Z",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

/** Answer the snapshot and history RPCs with the server's view. */
function serverHas(status: SessionAgentStatus, messages: ChatMessage[]) {
  sendRemoteCommand.mockImplementation(async (_conn: string, method: string) =>
    method === "get_chat_snapshot"
      ? { session: { agent_status: status }, pending_controls: [] }
      : { messages },
  );
}

function sessionStatus(): SessionAgentStatus | undefined {
  return useAppStore.getState().sessionsByWorkspace["remote-ws"]?.[0]?.agent_status;
}

describe("hydrateRemotePendingControls", () => {
  const prompt = makeMessage("m1", "User", "do it");
  const reply = makeMessage("m2", "Assistant", "done");

  beforeEach(() => {
    sendRemoteCommand.mockReset();
    useAppStore.setState({
      agentQuestions: {},
      planApprovals: {},
      agentApprovals: {},
      sessionsByWorkspace: { "remote-ws": [makeSession("Running")] },
      chatMessages: { [SESSION]: [prompt] },
      streamingContent: { [SESSION]: "partial" },
      toolActivities: {},
      completedTurns: {},
      promptStartTime: {},
    });
  });

  it("closes out a turn whose end was lost", async () => {
    useAppStore.getState().setToolActivities(SESSION, [
      {
        toolUseId: "tool-1",
        toolName: "Read",
        inputJson: "{}",
        resultText: "ok",
        collapsed: true,
        summary: "",
      },
    ]);
    useAppStore.getState().setPromptStartTime("remote-ws", 1);
    serverHas("Idle", [prompt, reply]);
    await hydrateRemotePendingControls("conn-1", SESSION);
    const s = useAppStore.getState();
    expect(sessionStatus()).toBe("Idle");
    // The turn's tool calls are kept as a completed turn.
    expect(s.toolActivities[SESSION] ?? []).toEqual([]);
    expect(s.completedTurns[SESSION]?.[0]?.activities.map((a) => a.toolUseId)).toEqual(["tool-1"]);
    expect(s.promptStartTime["remote-ws"]).toBeUndefined();
    expect(s.chatMessages[SESSION].map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.streamingContent[SESSION] ?? "").toBe("");
  });

  it("leaves a session a live event touched while the snapshot was in flight", async () => {
    sendRemoteCommand.mockImplementation(async (_conn: string, method: string) => {
      if (method === "get_chat_snapshot") {
        // A live delta lands before the snapshot response.
        useAppStore.getState().setStreamingContent(SESSION, "partial, more");
        return { session: { agent_status: "Idle" }, pending_controls: [] };
      }
      return { messages: [prompt, reply] };
    });
    await hydrateRemotePendingControls("conn-1", SESSION);
    expect(sessionStatus()).toBe("Running");
    expect(useAppStore.getState().chatMessages[SESSION].map((m) => m.id)).toEqual(["m1"]);
  });

  it("reloads an open transcript on request even when the status agrees", async () => {
    useAppStore.setState({
      sessionsByWorkspace: { "remote-ws": [makeSession("Idle")] },
      streamingContent: {},
    });
    serverHas("Idle", [prompt, reply]);
    await hydrateRemotePendingControls("conn-1", SESSION, { reloadHistory: true });
    expect(useAppStore.getState().chatMessages[SESSION].map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});
