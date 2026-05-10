interface SubmitPlanApprovalResponseArgs {
  sessionId: string;
  toolUseId: string;
  approved: boolean;
  reason?: string;
  remoteConnectionId?: string | null;
  submitPlanApproval: (
    sessionId: string,
    toolUseId: string,
    approved: boolean,
    reason?: string,
  ) => Promise<void>;
  sendRemoteCommand: (
    connectionId: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

const STALE_PLAN_APPROVAL_ERROR =
  "No pending permission request for tool_use_id";

export function isStalePlanApprovalError(error: unknown): boolean {
  return String(error).includes(STALE_PLAN_APPROVAL_ERROR);
}

export async function submitPlanApprovalResponse({
  sessionId,
  toolUseId,
  approved,
  reason,
  remoteConnectionId,
  submitPlanApproval,
  sendRemoteCommand,
}: SubmitPlanApprovalResponseArgs): Promise<void> {
  if (remoteConnectionId) {
    await sendRemoteCommand(remoteConnectionId, "vote_plan_approval", {
      chat_session_id: sessionId,
      tool_use_id: toolUseId,
      approved,
      reason: reason ?? null,
    });
    return;
  }

  await submitPlanApproval(sessionId, toolUseId, approved, reason);
}
