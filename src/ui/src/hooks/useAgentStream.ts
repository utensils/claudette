import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import { loadChatHistory, saveTurnToolActivities } from "../services/tauri";
import type { AgentStreamPayload } from "../types/agent-events";
import type { ChatMessage } from "../types/chat";
import type { ConversationCheckpoint } from "../types/checkpoint";
import { extractToolSummary } from "./toolSummary";
import { parseAskUserQuestion } from "./parseAgentQuestion";
import { debugChat } from "../utils/chatDebug";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export function useAgentStream() {
  const appendStreamingContent = useAppStore((s) => s.appendStreamingContent);
  const setStreamingContent = useAppStore((s) => s.setStreamingContent);
  const appendStreamingThinking = useAppStore((s) => s.appendStreamingThinking);
  const clearStreamingThinking = useAppStore((s) => s.clearStreamingThinking);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToolActivity = useAppStore((s) => s.addToolActivity);
  const updateToolActivity = useAppStore((s) => s.updateToolActivity);
  const appendToolActivityInput = useAppStore(
    (s) => s.appendToolActivityInput
  );
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const setAgentQuestion = useAppStore((s) => s.setAgentQuestion);
  const setPlanApproval = useAppStore((s) => s.setPlanApproval);
  const finalizeTurn = useAppStore((s) => s.finalizeTurn);
  const setPlanMode = useAppStore((s) => s.setPlanMode);

  // Map content block index → { toolUseId, toolName } for the current turn.
  // Reset on process exit.
  const blockToolMapRef = useRef<
    Record<number, { toolUseId: string; toolName: string }>
  >({});
  // Count assistant messages in the current turn for the summary.
  const turnMessageCountRef = useRef<Record<string, number>>({});
  // Track whether the current turn has already been finalized (by the
  // `result` event) so that `ProcessExited` doesn't double-finalize.
  const turnFinalizedRef = useRef<Record<string, boolean>>({});
  // Checkpoint IDs arrive before the `result` event; reuse them as the
  // completed turn IDs so later DB hydration can merge without duplication.
  const turnCheckpointIdRef = useRef<Record<string, string | undefined>>({});
  // Plan file path extracted from EnterPlanMode tool results, keyed by wsId.
  const planFilePathRef = useRef<Record<string, string>>({});
  // Track content block indices that are thinking blocks, keyed by workspace.
  const thinkingBlocksRef = useRef<Record<string, Set<number>>>({});

  useEffect(() => {
    // Guard against StrictMode double-mount: the async unlisten() promise
    // can't block React's synchronous remount, so a stale listener may
    // briefly coexist with the new one. This flag prevents the stale
    // listener from processing events.
    let active = true;
    const unlisten = listen<AgentStreamPayload>("agent-stream", (event) => {
      if (!active) return;
      const { workspace_id: wsId, event: agentEvent } = event.payload;

      if ("ProcessExited" in agentEvent) {
        debugChat("stream", "ProcessExited", {
          wsId,
          alreadyFinalized: !!turnFinalizedRef.current[wsId],
          checkpointId: turnCheckpointIdRef.current[wsId] ?? null,
          pendingMessageCount: turnMessageCountRef.current[wsId] || 0,
          pendingToolCount: (useAppStore.getState().toolActivities[wsId] || []).length,
        });
        // Only finalize if the `result` event hasn't already done so.
        if (!turnFinalizedRef.current[wsId]) {
          finalizeTurn(
            wsId,
            turnMessageCountRef.current[wsId] || 0,
            turnCheckpointIdRef.current[wsId]
          );
        }
        turnMessageCountRef.current[wsId] = 0;
        turnFinalizedRef.current[wsId] = false;
        turnCheckpointIdRef.current[wsId] = undefined;
        updateWorkspace(wsId, { agent_status: "Idle" });
        setStreamingContent(wsId, "");
        clearStreamingThinking(wsId);
        blockToolMapRef.current = {};
        delete thinkingBlocksRef.current[wsId];
        // NOTE: Do NOT clear agentQuestion here. In --print mode the CLI
        // exits immediately after emitting AskUserQuestion, so ProcessExited
        // fires before the user has a chance to answer. The question is
        // cleared when the user responds (onRespond) or sends a new message.

        // Notification: mark workspace as unread if not currently selected
        const { selectedWorkspaceId, markWorkspaceAsUnread } = useAppStore.getState();
        if (wsId !== selectedWorkspaceId) {
          markWorkspaceAsUnread(wsId);
        }

        // Audio notification: play bell if enabled and workspace is in background.
        const { audioNotifications } = useAppStore.getState();
        if (audioNotifications && wsId !== selectedWorkspaceId) {
          try {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZSA0PVqzn77BdGAg+ltryxnMkBSp+zPLaizsIGGS57OihUBELTKXh8bllHAU2jdXyz4IzBh1qwO/mnEoPEFWs5++vXRgIPpbZ8sR0IwUpfszy2Ys7CBhkueznolARDEul4fG5ZRwFN43V8s+CMwYcacDv5pxKDxBVrOfvrl0YCD6W2fLEdCMFKX7M8tmLOwgYZLns6KJQEQxLpeHxuWUcBTeN1fLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLaizsIGGS57OiiUBEMS6Xh8bllHAU3jdXyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEFWs5++uXRgIPpbZ8sR0IwUpfszy2Ys7CBhkuezooleRDBIp+DwumQcBTOP1PLPgjMGHGnA7+acSg8QVazn765dGAg+ltnyw3MkBSl+zPLZizsIGGS57OmiUBEMSaXh8bhlHAU2jdTyz4IzBhxpwO/mnEoPEA==');
            audio.volume = 0.5;
            audio.play().catch(() => {});
          } catch {
            // Audio playback not supported in this environment.
          }
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
                  if (
                    "type" in delta &&
                    delta.type === "thinking_delta" &&
                    "thinking" in delta &&
                    delta.thinking
                  ) {
                    appendStreamingThinking(wsId, delta.thinking);
                  }
                  break;
                }
                case "content_block_start": {
                  if (
                    inner.content_block &&
                    "type" in inner.content_block &&
                    inner.content_block.type === "thinking"
                  ) {
                    (thinkingBlocksRef.current[wsId] ??= new Set()).add(inner.index);
                    // Clear previous thinking — new turn's thinking replaces old.
                    clearStreamingThinking(wsId);
                  }
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
                  if (thinkingBlocksRef.current[wsId]?.has(inner.index)) {
                    thinkingBlocksRef.current[wsId].delete(inner.index);
                    break;
                  }
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

                  // Handle ExitPlanMode — show approval card.
                  if (entry.toolName === "ExitPlanMode") {
                    let allowedPrompts: Array<{ tool: string; prompt: string }> = [];
                    if (activity?.inputJson) {
                      try {
                        const parsed = JSON.parse(activity.inputJson);
                        if (Array.isArray(parsed.allowedPrompts)) {
                          allowedPrompts = parsed.allowedPrompts;
                        }
                      } catch { /* ignore */ }
                    }

                    // Extract absolute plan file path from ALL messages (the
                    // path is typically mentioned when entering plan mode,
                    // which may be many messages back). Search newest-first.
                    const planPathRe = /(\/[^\s)"`]+\/\.claude\/plans\/[^\s)"`]+\.md)/;
                    const messages = useAppStore.getState().chatMessages[wsId] || [];
                    let planFilePath: string | null = null;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      const m = messages[i].content.match(planPathRe);
                      if (m) { planFilePath = m[1]; break; }
                    }

                    // Also check current streaming content and tool activity
                    // input (the plan path may appear in tool results).
                    if (!planFilePath) {
                      const streaming = useAppStore.getState().streamingContent[wsId] || "";
                      const m = streaming.match(planPathRe);
                      if (m) planFilePath = m[1];
                    }
                    if (!planFilePath) {
                      const allActivities = useAppStore.getState().toolActivities[wsId] || [];
                      for (const act of allActivities) {
                        const m = (act.inputJson + act.resultText).match(planPathRe);
                        if (m) { planFilePath = m[1]; break; }
                      }
                    }
                    // Fall back to cached path from EnterPlanMode tool result.
                    if (!planFilePath && planFilePathRef.current[wsId]) {
                      planFilePath = planFilePathRef.current[wsId];
                    }

                    setPlanApproval({
                      workspaceId: wsId,
                      toolUseId: entry.toolUseId,
                      planFilePath,
                      allowedPrompts,
                    });
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
              debugChat("stream", "assistant", {
                wsId,
                textLength: text.length,
                turnMessageCount: turnMessageCountRef.current[wsId],
              });
              addChatMessage(wsId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                role: "Assistant",
                content: text,
                cost_usd: null,
                duration_ms: null,
                created_at: new Date().toISOString(),
                thinking: useAppStore.getState().streamingThinking[wsId] || null,
              });
            }
            setStreamingContent(wsId, "");
            // Clear streaming thinking now that it's been committed to the
            // assistant message — the persisted msg.thinking handles display.
            clearStreamingThinking(wsId);
            break;
          }
          case "result": {
            debugChat("stream", "result", {
              wsId,
              checkpointId: turnCheckpointIdRef.current[wsId] ?? null,
              pendingMessageCount: turnMessageCountRef.current[wsId] || 0,
              pendingToolCount: (useAppStore.getState().toolActivities[wsId] || []).length,
            });
            finalizeTurn(
              wsId,
              turnMessageCountRef.current[wsId] || 0,
              turnCheckpointIdRef.current[wsId]
            );
            turnMessageCountRef.current[wsId] = 0;
            turnFinalizedRef.current[wsId] = true;
            updateWorkspace(wsId, { agent_status: "Idle" });
            break;
          }
          case "user": {
            // Tool results — update matching tool activities and extract
            // plan file path from EnterPlanMode results.
            const planPathRe = /(\/[^\s)"`]+\/\.claude\/plans\/[^\s)"`]+\.md)/;
            for (const block of streamEvent.message.content) {
              if (block.type === "tool_result") {
                const text =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                updateToolActivity(wsId, block.tool_use_id, {
                  resultText: text,
                });
                // Capture plan file path from tool results (e.g. EnterPlanMode).
                const pm = text.match(planPathRe);
                if (pm) planFilePathRef.current[wsId] = pm[1];
              }
            }
            break;
          }
        }
      }
    });

    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [
    appendStreamingContent,
    setStreamingContent,
    appendStreamingThinking,
    clearStreamingThinking,
    addChatMessage,
    addToolActivity,
    updateToolActivity,
    appendToolActivityInput,
    updateWorkspace,
    setAgentQuestion,
    setPlanApproval,
    finalizeTurn,
    setPlanMode,
  ]);

  // Listen for checkpoint-created events from the backend.
  const addCheckpoint = useAppStore((s) => s.addCheckpoint);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      workspace_id: string;
      checkpoint: ConversationCheckpoint;
    }>("checkpoint-created", (event) => {
      if (!active) return;
      const { workspace_id: wsId, checkpoint } = event.payload;
      addCheckpoint(wsId, checkpoint);
      turnCheckpointIdRef.current[wsId] = checkpoint.id;

      // Persist tool activities for the just-completed turn, then reload
      // messages so the store has DB-persisted IDs. The save MUST complete
      // before any subsequent loadCompletedTurns() reads, otherwise the DB
      // snapshot will be stale and overwrite the in-memory turns.
      // NOTE: checkpoint-created fires BEFORE the agent-stream result event,
      // so finalizeTurn() hasn't run yet. Read from toolActivities (pre-
      // finalization) and turnMessageCountRef instead of completedTurns.
      const currentActivities = useAppStore.getState().toolActivities[wsId] || [];
      debugChat("stream", "checkpoint-created", {
        wsId,
        checkpointId: checkpoint.id,
        checkpointMessageId: checkpoint.message_id,
        turnIndex: checkpoint.turn_index,
        currentToolCount: currentActivities.length,
        pendingMessageCount: turnMessageCountRef.current[wsId] || 0,
      });
      const savePromise = currentActivities.length > 0
        ? (() => {
            const messageCount = turnMessageCountRef.current[wsId] || 0;
            const activities = currentActivities.map((a, i) => ({
              id: crypto.randomUUID(),
              checkpoint_id: checkpoint.id,
              tool_use_id: a.toolUseId,
              tool_name: a.toolName,
              input_json: a.inputJson,
              result_text: a.resultText,
              summary: a.summary,
              sort_order: i,
            }));
            return saveTurnToolActivities(checkpoint.id, messageCount, activities);
          })()
        : Promise.resolve();

      // Wait for the save to finish, then reload messages so the store has
      // the persisted message IDs (frontend assigns its own UUIDs during
      // streaming, which won't match checkpoint.message_id).
      savePromise
        .then(() => {
          debugChat("stream", "checkpoint-save-complete", {
            wsId,
            checkpointId: checkpoint.id,
          });
        })
        .catch((e) => {
          console.error("Failed to save turn tool activities:", e);
          debugChat("stream", "checkpoint-save-failed", {
            wsId,
            checkpointId: checkpoint.id,
            error: String(e),
          });
        })
        .then(() => loadChatHistory(wsId))
        .then((msgs) => {
          if (!msgs) return;
          const filtered = msgs.filter(
            (m: ChatMessage) => m.role !== "Assistant" || m.content.trim() !== "",
          );
          debugChat("stream", "checkpoint-reload-chat-history", {
            wsId,
            checkpointId: checkpoint.id,
            messageCount: filtered.length,
            messageIds: filtered.map((msg) => msg.id),
          });
          setChatMessages(wsId, filtered);
        })
        .catch((e) => console.error("Failed to reload messages after checkpoint:", e));
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [addCheckpoint, setChatMessages]);

  // Listen for workspace-renamed events (auto-rename after first prompt).
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      workspace_id: string;
      name: string;
      branch_name: string;
    }>("workspace-renamed", (event) => {
      if (!active) return;
      const { workspace_id: wsId, name, branch_name } = event.payload;
      updateWorkspace(wsId, { name, branch_name });
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [updateWorkspace]);
}
