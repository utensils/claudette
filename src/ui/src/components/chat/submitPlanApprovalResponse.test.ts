import { describe, expect, it, vi } from "vitest";
import {
  isStalePlanApprovalError,
  submitPlanApprovalResponse,
} from "./submitPlanApprovalResponse";

describe("submitPlanApprovalResponse", () => {
  it("routes local approvals through submitPlanApproval", async () => {
    const submitPlanApproval = vi.fn().mockResolvedValue(undefined);
    const sendRemoteCommand = vi.fn().mockResolvedValue(undefined);

    await submitPlanApprovalResponse({
      sessionId: "session-1",
      toolUseId: "tool-1",
      approved: true,
      submitPlanApproval,
      sendRemoteCommand,
    });

    expect(submitPlanApproval).toHaveBeenCalledWith(
      "session-1",
      "tool-1",
      true,
      undefined,
    );
    expect(sendRemoteCommand).not.toHaveBeenCalled();
  });

  it("routes remote approvals through vote_plan_approval", async () => {
    const submitPlanApproval = vi.fn().mockResolvedValue(undefined);
    const sendRemoteCommand = vi.fn().mockResolvedValue(undefined);

    await submitPlanApprovalResponse({
      sessionId: "session-1",
      toolUseId: "tool-1",
      approved: false,
      reason: "Needs changes",
      remoteConnectionId: "remote-1",
      submitPlanApproval,
      sendRemoteCommand,
    });

    expect(sendRemoteCommand).toHaveBeenCalledWith(
      "remote-1",
      "vote_plan_approval",
      {
        chat_session_id: "session-1",
        tool_use_id: "tool-1",
        approved: false,
        reason: "Needs changes",
      },
    );
    expect(submitPlanApproval).not.toHaveBeenCalled();
  });

  it("identifies stale plan approval backend errors", () => {
    expect(
      isStalePlanApprovalError(
        "No pending permission request for tool_use_id tool-1 (pending: [])",
      ),
    ).toBe(true);
    expect(isStalePlanApprovalError("network unavailable")).toBe(false);
  });
});
