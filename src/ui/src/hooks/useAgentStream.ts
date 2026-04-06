import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import type { AgentQuestionItem } from "../stores/useAppStore";
import type { AgentStreamPayload } from "../types/agent-events";
import { extractToolSummary } from "./toolSummary";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * Parse AskUserQuestion tool input JSON into question items.
 * Supports two formats:
 * - Single: { question: "...", options: [...] }
 * - Multi:  { questions: [{ header?, question, options, multiSelect? }] }
 *
 * Options can be strings or objects with label/description fields.
 */
function parseAskUserQuestion(
  parsed: Record<string, unknown>
): AgentQuestionItem[] {
  // Multi-question format
  if (Array.isArray(parsed.questions)) {
    return parsed.questions.map((q: Record<string, unknown>) => ({
      header: typeof q.header === "string" ? q.header : undefined,
      question: typeof q.question === "string" ? q.question : "",
      options: parseOptions(q.options),
      multiSelect: q.multiSelect === true,
    }));
  }

  // Single-question format
  if (typeof parsed.question === "string") {
    return [
      {
        question: parsed.question,
        options: parseOptions(parsed.options),
        multiSelect: false,
      },
    ];
  }

  return [];
}

function parseOptions(
  raw: unknown
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((opt: unknown) => {
    if (typeof opt === "string") return { label: opt };
    if (typeof opt === "object" && opt !== null) {
      const o = opt as Record<string, unknown>;
      return {
        label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
        description:
          typeof o.description === "string" ? o.description : undefined,
      };
    }
    return { label: String(opt) };
  });
}

export function useAgentStream() {
  const appendStreamingContent = useAppStore((s) => s.appendStreamingContent);
  const setStreamingContent = useAppStore((s) => s.setStreamingContent);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToolActivity = useAppStore((s) => s.addToolActivity);
  const updateToolActivity = useAppStore((s) => s.updateToolActivity);
  const appendToolActivityInput = useAppStore(
    (s) => s.appendToolActivityInput
  );
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const setAgentQuestion = useAppStore((s) => s.setAgentQuestion);
  const finalizeTurn = useAppStore((s) => s.finalizeTurn);
  const setPlanMode = useAppStore((s) => s.setPlanMode);

  // Map content block index → { toolUseId, toolName } for the current turn.
  // Reset on process exit.
  const blockToolMapRef = useRef<
    Record<number, { toolUseId: string; toolName: string }>
  >({});
  // Count assistant messages in the current turn for the summary.
  const turnMessageCountRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const unlisten = listen<AgentStreamPayload>("agent-stream", (event) => {
      const { workspace_id: wsId, event: agentEvent } = event.payload;

      if ("ProcessExited" in agentEvent) {
        finalizeTurn(wsId, turnMessageCountRef.current[wsId] || 0);
        turnMessageCountRef.current[wsId] = 0;
        updateWorkspace(wsId, { agent_status: "Idle" });
        setStreamingContent(wsId, "");
        blockToolMapRef.current = {};
        // Clear pending question for this workspace
        const currentQuestion = useAppStore.getState().agentQuestion;
        if (currentQuestion?.workspaceId === wsId) {
          setAgentQuestion(null);
        }

        // Notification: mark workspace as unread if not currently selected
        const { selectedWorkspaceId, markWorkspaceAsUnread } = useAppStore.getState();
        if (wsId !== selectedWorkspaceId) {
          markWorkspaceAsUnread(wsId);
        }

        // Audio notification: play terminal bell sound
        console.log('[useAgentStream] Agent completed, playing audio notification for workspace:', wsId);
        try {
          const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZSA0PVqzn77BdGAg+ltryxnMkBSp+zPLaizsIGGS57OihUBELTKXh8bllHAU2jdXyz4IzBh1qwO/mnEoPEFWs5++vXRgIPpbZ8sR0IwUpfszy2Ys7CBhkueznolARDEul4fG5ZRwFN43V8s+CMwYcacDv5pxKDxBVrOfvrl0YCD6W2fLEdCMFKX7M8tmLOwgYZLns6KJQEQxLpeHxuWUcBTeN1fLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLaizsIGGS57OiiUBEMS6Xh8bllHAU3jdXyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEA==');
          audio.volume = 0.5;
          audio.play().catch((err) => {
            console.error('[useAgentStream] Failed to play audio notification:', err);
          });
        } catch (err) {
          console.error('[useAgentStream] Error creating audio:', err);
        }

        return;
      }

      const streamEvent = agentEvent.Stream;
      if (!streamEvent) return;

      // Handle different stream event types based on the Rust enum serialization
      if ("type" in streamEvent) {
        switch (streamEvent.type) {
          case "stream_event": {
            const inner = streamEvent.event;
            if ("type" in inner) {
              switch (inner.type) {
                case "content_block_delta": {
                  const delta = inner.delta;
                  if ("type" in delta && delta.type === "text_delta") {
                    appendStreamingContent(wsId, delta.text);
                  }
                  if (
                    "type" in delta &&
                    delta.type === "input_json_delta" &&
                    delta.partial_json
                  ) {
                    const entry = blockToolMapRef.current[inner.index];
                    if (entry) {
                      appendToolActivityInput(
                        wsId,
                        entry.toolUseId,
                        delta.partial_json
                      );
                    }
                  }
                  if (
                    "type" in delta &&
                    delta.type === "tool_use_delta" &&
                    delta.partial_json
                  ) {
                    const entry = blockToolMapRef.current[inner.index];
                    if (entry) {
                      appendToolActivityInput(
                        wsId,
                        entry.toolUseId,
                        delta.partial_json
                      );
                    }
                  }
                  break;
                }
                case "content_block_start": {
                  if (
                    inner.content_block &&
                    "type" in inner.content_block &&
                    inner.content_block.type === "tool_use"
                  ) {
                    blockToolMapRef.current[inner.index] = {
                      toolUseId: inner.content_block.id,
                      toolName: inner.content_block.name,
                    };
                    addToolActivity(wsId, {
                      toolUseId: inner.content_block.id,
                      toolName: inner.content_block.name,
                      inputJson: "",
                      resultText: "",
                      collapsed: true,
                      summary: "",
                    });
                    // Detect plan mode changes from agent tool calls.
                    if (inner.content_block.name === "EnterPlanMode") {
                      setPlanMode(wsId, true);
                    } else if (inner.content_block.name === "ExitPlanMode") {
                      setPlanMode(wsId, false);
                    }
                  }
                  break;
                }
                case "content_block_stop": {
                  const entry = blockToolMapRef.current[inner.index];
                  if (!entry) break;

                  // Read accumulated input JSON from the tool activity.
                  const activities =
                    useAppStore.getState().toolActivities[wsId] || [];
                  const activity = activities.find(
                    (a) => a.toolUseId === entry.toolUseId
                  );

                  // Extract a one-line summary from the tool input.
                  if (activity?.inputJson) {
                    const summary = extractToolSummary(
                      entry.toolName,
                      activity.inputJson
                    );
                    if (summary) {
                      updateToolActivity(wsId, entry.toolUseId, { summary });
                    }
                  }

                  // Handle AskUserQuestion specifically.
                  if (
                    entry.toolName === ASK_USER_QUESTION_TOOL &&
                    activity?.inputJson
                  ) {
                    try {
                      const parsed = JSON.parse(activity.inputJson);
                      const questions = parseAskUserQuestion(parsed);
                      if (questions.length > 0) {
                        setAgentQuestion({
                          workspaceId: wsId,
                          toolUseId: entry.toolUseId,
                          questions,
                        });
                      }
                    } catch {
                      // Malformed JSON — ignore, question won't show
                    }
                  }
                  break;
                }
              }
            }
            break;
          }
          case "assistant": {
            // Full message received — it's already persisted by the backend.
            const text = streamEvent.message.content
              .filter(
                (b): b is { type: "text"; text: string } => b.type === "text"
              )
              .map((b) => b.text)
              .join("");
            if (text) {
              turnMessageCountRef.current[wsId] =
                (turnMessageCountRef.current[wsId] || 0) + 1;
              addChatMessage(wsId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                role: "Assistant",
                content: text,
                cost_usd: null,
                duration_ms: null,
                created_at: new Date().toISOString(),
              });
            }
            setStreamingContent(wsId, "");
            break;
          }
          case "result": {
            finalizeTurn(wsId, turnMessageCountRef.current[wsId] || 0);
            turnMessageCountRef.current[wsId] = 0;
            updateWorkspace(wsId, { agent_status: "Idle" });
            break;
          }
          case "user": {
            // Tool results — update matching tool activities
            for (const block of streamEvent.message.content) {
              if (block.type === "tool_result") {
                updateToolActivity(wsId, block.tool_use_id, {
                  resultText:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content),
                });
              }
            }
            break;
          }
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    appendStreamingContent,
    setStreamingContent,
    addChatMessage,
    addToolActivity,
    updateToolActivity,
    appendToolActivityInput,
    updateWorkspace,
    setAgentQuestion,
    finalizeTurn,
    setPlanMode,
  ]);
}
