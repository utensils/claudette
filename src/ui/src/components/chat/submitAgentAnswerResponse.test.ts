import { describe, expect, it, vi } from "vitest";
import { submitAgentAnswerResponse } from "./submitAgentAnswerResponse";

describe("submitAgentAnswerResponse", () => {
  it("submits local AskUserQuestion answers through the Tauri command", async () => {
    const submitAgentAnswer = vi.fn().mockResolvedValue(undefined);
    const sendRemoteCommand = vi.fn();

    await submitAgentAnswerResponse({
      sessionId: "session-1",
      toolUseId: "tool-1",
      answers: { Choice: "A" },
      submitAgentAnswer,
      sendRemoteCommand,
    });

    expect(submitAgentAnswer).toHaveBeenCalledWith("session-1", "tool-1", {
      Choice: "A",
    }, undefined);
    expect(sendRemoteCommand).not.toHaveBeenCalled();
  });

  it("submits remote AskUserQuestion answers through the collaboration RPC", async () => {
    const submitAgentAnswer = vi.fn();
    const sendRemoteCommand = vi.fn().mockResolvedValue(null);

    await submitAgentAnswerResponse({
      sessionId: "session-1",
      toolUseId: "tool-1",
      answers: { Choice: "A" },
      annotations: { source: "button" },
      remoteConnectionId: "remote-1",
      submitAgentAnswer,
      sendRemoteCommand,
    });

    expect(sendRemoteCommand).toHaveBeenCalledWith(
      "remote-1",
      "submit_agent_answer",
      {
        chat_session_id: "session-1",
        tool_use_id: "tool-1",
        answers: { Choice: "A" },
        annotations: { source: "button" },
      },
    );
    expect(submitAgentAnswer).not.toHaveBeenCalled();
  });
});
