export interface SubmitAgentAnswerResponseArgs {
  sessionId: string;
  toolUseId: string;
  answers: Record<string, string>;
  annotations?: unknown;
  remoteConnectionId?: string;
  submitAgentAnswer: (
    sessionId: string,
    toolUseId: string,
    answers: Record<string, string>,
    annotations?: unknown,
  ) => Promise<void>;
  sendRemoteCommand: (
    connectionId: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export async function submitAgentAnswerResponse({
  sessionId,
  toolUseId,
  answers,
  annotations,
  remoteConnectionId,
  submitAgentAnswer,
  sendRemoteCommand,
}: SubmitAgentAnswerResponseArgs): Promise<void> {
  if (remoteConnectionId) {
    await sendRemoteCommand(remoteConnectionId, "submit_agent_answer", {
      chat_session_id: sessionId,
      tool_use_id: toolUseId,
      answers,
      annotations: annotations ?? null,
    });
    return;
  }

  await submitAgentAnswer(sessionId, toolUseId, answers, annotations);
}
