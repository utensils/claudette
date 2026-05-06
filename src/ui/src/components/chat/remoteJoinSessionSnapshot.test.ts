import { describe, expect, it, vi } from "vitest";
import { applyRemoteJoinSessionSnapshot } from "./remoteJoinSessionSnapshot";
import type { Participant } from "../../stores/slices/collabSlice";

const alice: Participant = {
  id: "alice-id",
  display_name: "Alice",
  is_host: false,
  joined_at: 1,
  muted: false,
};

const host: Participant = {
  id: "host",
  display_name: "Host",
  is_host: true,
  joined_at: 0,
  muted: false,
};

describe("applyRemoteJoinSessionSnapshot", () => {
  it("hydrates participants from the join_session snapshot", () => {
    const setParticipants = vi.fn();
    const setTurnHolder = vi.fn();

    applyRemoteJoinSessionSnapshot(
      "session-1",
      {
        participants: [host, alice],
        turn_holder: null,
      },
      {
        setParticipants,
        setTurnHolder,
      },
    );

    expect(setParticipants).toHaveBeenCalledWith("session-1", [host, alice]);
    expect(setTurnHolder).toHaveBeenCalledWith("session-1", null);
  });

  it("hydrates the current turn holder display name when present", () => {
    const setParticipants = vi.fn();
    const setTurnHolder = vi.fn();
    const setPromptStartTime = vi.fn();
    const setSelectedModel = vi.fn();
    const setPlanMode = vi.fn();

    applyRemoteJoinSessionSnapshot(
      "session-1",
      {
        participants: [host, alice],
        turn_holder: "alice-id",
        turn_started_at_ms: 1710000000000,
        turn_settings: {
          model: "opus",
          plan_mode: true,
        },
      },
      {
        setParticipants,
        setTurnHolder,
        setPromptStartTime,
        setSelectedModel,
        setPlanMode,
      },
    );

    expect(setTurnHolder).toHaveBeenCalledWith("session-1", {
      participant_id: "alice-id",
      display_name: "Alice",
    });
    expect(setPromptStartTime).toHaveBeenCalledWith(1710000000000);
    expect(setSelectedModel).toHaveBeenCalledWith("session-1", "opus");
    expect(setPlanMode).toHaveBeenCalledWith("session-1", true);
  });

  it("ignores non-object 1:1 responses", () => {
    const setParticipants = vi.fn();
    const setTurnHolder = vi.fn();

    applyRemoteJoinSessionSnapshot("session-1", null, {
      setParticipants,
      setTurnHolder,
    });

    expect(setParticipants).not.toHaveBeenCalled();
    expect(setTurnHolder).not.toHaveBeenCalled();
  });

  it("hydrates pending plan approval consensus after reconnect", () => {
    const setParticipants = vi.fn();
    const setTurnHolder = vi.fn();
    const openConsensusVote = vi.fn();
    const recordConsensusVote = vi.fn();
    const setPlanApproval = vi.fn();
    const setPlanMode = vi.fn();

    applyRemoteJoinSessionSnapshot(
      "session-1",
      {
        participants: [host, alice],
        pending_vote: {
          tool_use_id: "tool-1",
          required_voters: [host, alice],
          votes: { "alice-id": { kind: "approve" } },
          plan_file_path:
            "/repo/.claude/plans/testing-plan-mode-make-precious-umbrella.md",
          input: {
            allowedPrompts: [{ tool: "Edit", prompt: "Allowed edit" }],
          },
        },
      },
      {
        setParticipants,
        setTurnHolder,
        openConsensusVote,
        recordConsensusVote,
        setPlanApproval,
        setPlanMode,
      },
    );

    expect(openConsensusVote).toHaveBeenCalledWith("session-1", "tool-1", [
      host,
      alice,
    ]);
    expect(recordConsensusVote).toHaveBeenCalledWith(
      "session-1",
      "tool-1",
      "alice-id",
      { kind: "approve" },
    );
    expect(setPlanApproval).toHaveBeenCalledWith({
      sessionId: "session-1",
      toolUseId: "tool-1",
      planFilePath:
        "/repo/.claude/plans/testing-plan-mode-make-precious-umbrella.md",
      allowedPrompts: [{ tool: "Edit", prompt: "Allowed edit" }],
    });
    expect(setPlanMode).toHaveBeenCalledWith("session-1", false);
  });

  it("hydrates pending AskUserQuestion after reconnect", () => {
    const setParticipants = vi.fn();
    const setTurnHolder = vi.fn();
    const setAgentQuestion = vi.fn();

    applyRemoteJoinSessionSnapshot(
      "session-1",
      {
        participants: [host, alice],
        pending_question: {
          tool_use_id: "question-tool",
          required_voters: [host, alice],
          votes: {
            "alice-id": {
              answers: { "What should change?": "Simplify" },
            },
          },
          input: {
            question: "What should change?",
            options: [
              {
                label: "Simplify",
                description: "Cut it down",
              },
            ],
          },
        },
      },
      {
        setParticipants,
        setTurnHolder,
        setAgentQuestion,
      },
    );

    expect(setAgentQuestion).toHaveBeenCalledWith({
      sessionId: "session-1",
      toolUseId: "question-tool",
      requiredVoters: [host, alice],
      votes: {
        "alice-id": {
          answers: { "What should change?": "Simplify" },
        },
      },
      questions: [
        {
          question: "What should change?",
          options: [
            {
              label: "Simplify",
              description: "Cut it down",
            },
          ],
          multiSelect: false,
        },
      ],
    });
  });
});
