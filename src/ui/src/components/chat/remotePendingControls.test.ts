import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import { reconcilePendingControls } from "./remotePendingControls";

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
