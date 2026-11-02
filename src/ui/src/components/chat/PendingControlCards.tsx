import type { Dispatch, SetStateAction } from "react";
import {
  submitAgentAnswer,
  submitAgentApproval,
  submitPlanApproval,
} from "../../services/tauri";
import type { AttachmentInput } from "../../types/chat";
import { AgentApprovalCard } from "./AgentApprovalCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { setPlanModeAndPersist } from "./planModePersistence";
import type { useChatPanelStore } from "./useChatPanelStore";

type ChatPanelStore = ReturnType<typeof useChatPanelStore>;

/**
 * The interactive cards an agent can block on — AskUserQuestion, plan
 * approval (Claude ExitPlanMode or a Codex plan), and tool approval — with
 * their submit handlers. Extracted from `ChatPanelSessionView`, which only
 * decides where they render.
 */
export function PendingControlCards({
  activeSessionId,
  selectedWorkspaceId,
  ws,
  pendingQuestion,
  pendingPlan,
  pendingApproval,
  clearAgentQuestion,
  clearPlanApproval,
  clearAgentApproval,
  setError,
  onSend,
}: Pick<
  ChatPanelStore,
  | "activeSessionId"
  | "selectedWorkspaceId"
  | "ws"
  | "pendingQuestion"
  | "pendingPlan"
  | "pendingApproval"
  | "clearAgentQuestion"
  | "clearPlanApproval"
  | "clearAgentApproval"
> & {
  setError: Dispatch<SetStateAction<string | null>>;
  onSend: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
}) {
  return (
    <>
      {pendingQuestion && (
        <AgentQuestionCard
          question={pendingQuestion}
          onRespond={async (answers) => {
            if (!activeSessionId) return;
            const sid = activeSessionId;
            const toolUseId = pendingQuestion.toolUseId;
            try {
              await submitAgentAnswer(sid, toolUseId, answers);
              clearAgentQuestion(sid);
            } catch (e) {
              console.error("Failed to submit agent answer:", e);
              setError(String(e));
            }
          }}
        />
      )}

      {pendingPlan && selectedWorkspaceId && (
        <PlanApprovalCard
          approval={pendingPlan}
          workspaceId={selectedWorkspaceId}
          remoteConnectionId={ws?.remote_connection_id ?? undefined}
          onRespond={async (approved, reason) => {
            if (!activeSessionId) return;
            const sid = activeSessionId;
            const toolUseId = pendingPlan.toolUseId;
            const codexPlanApproval = pendingPlan.source === "codex";
            try {
              await submitPlanApproval(sid, toolUseId, approved, reason);
              clearPlanApproval(sid);
              if (codexPlanApproval) {
                if (approved) {
                  await setPlanModeAndPersist(sid, false);
                  await onSend("Implement the plan.");
                } else if (reason?.trim()) {
                  await setPlanModeAndPersist(sid, true);
                  await onSend(
                    `${reason.trim()}\n\nRevise the plan to address this feedback. Do not begin implementation.`,
                  );
                }
              } else {
                await setPlanModeAndPersist(sid, false);
              }
            } catch (e) {
              console.error("Failed to submit plan approval:", e);
              setError(String(e));
            }
          }}
        />
      )}

      {pendingApproval && (
        <AgentApprovalCard
          approval={pendingApproval}
          onRespond={async (approved, reason) => {
            if (!activeSessionId) return;
            const sid = activeSessionId;
            const toolUseId = pendingApproval.toolUseId;
            try {
              await submitAgentApproval(sid, toolUseId, approved, reason);
              clearAgentApproval(sid);
            } catch (e) {
              console.error("Failed to submit agent approval:", e);
              setError(String(e));
            }
          }}
        />
      )}
    </>
  );
}
