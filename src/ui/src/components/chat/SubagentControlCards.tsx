import { Fragment } from "react";
import { parseCodexApproval } from "../../hooks/useAgentStream";
import { parseAskUserQuestion } from "../../hooks/parseAgentQuestion";
import { submitAgentAnswer, submitAgentApproval } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { subagentSessionKey } from "../../types/subagent";
import { AgentApprovalCard } from "./AgentApprovalCard";
import { AgentQuestionCard } from "./AgentQuestionCard";

interface Props {
  sessionId: string;
  connectionId: string | null;
  setError: (error: string) => void;
}

/** A parent turn and several children may all require a response at once. */
export function SubagentControlCards({ sessionId, connectionId, setError }: Props) {
  const key = subagentSessionKey(connectionId, sessionId);
  const controls = useAppStore((s) => s.subagentControls[key]);
  const runs = useAppStore((s) => s.subagentRuns[key]);
  const respond = async (id: string, reply: Promise<void>) => {
    try {
      await reply;
      useAppStore.getState().updateSubagentControl(connectionId, sessionId, id);
    } catch (error) {
      setError(String(error));
    }
  };
  return controls?.map(({ tool_use_id: id, tool_name: name, input }) => {
    const worker = input.subagent_run_id;
    const label = runs?.find((run) => run.run_id === worker)?.assignment ?? worker;
    let card;
    if (name === "AskUserQuestion") {
      const questions = parseAskUserQuestion(input);
      if (!questions.length) return null;
      card = <AgentQuestionCard question={{ sessionId, toolUseId: id, questions }}
        onRespond={(answers) => void respond(id, submitAgentAnswer(sessionId, id, answers, connectionId))} />;
    } else {
      const approval = parseCodexApproval(sessionId, id, name, input);
      if (!approval) return null;
      card = <AgentApprovalCard approval={approval}
        onRespond={(approved, reason) => void respond(id, submitAgentApproval(sessionId, id, approved, reason, connectionId))} />;
    }
    return <Fragment key={id}>{typeof label === "string" && <strong>{label}</strong>}{card}</Fragment>;
  });
}
