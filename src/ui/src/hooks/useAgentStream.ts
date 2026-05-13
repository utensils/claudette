import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import {
  loadChatHistory,
  saveTurnToolActivities,
  setSessionCliInvocation,
} from "../services/tauri";
import type { AgentStreamPayload } from "../types/agent-events";
import type {
  AgentApproval,
  AgentApprovalDetail,
  AgentApprovalKind,
  AgentToolCall,
} from "../stores/useAppStore";
import type { ChatMessage } from "../types/chat";
import type { ConversationCheckpoint } from "../types/checkpoint";
import type { TerminalTab } from "../types/terminal";
import { extractToolSummary } from "./toolSummary";
import { parseAskUserQuestion } from "./parseAgentQuestion";
import {
  type BlockToolMap,
  setBlockTool,
  getBlockTool,
  clearBlockToolsForSession,
} from "./blockToolMap";
import { debugChat } from "../utils/chatDebug";
import { extractLatestCallUsage } from "../utils/extractLatestCallUsage";
import { buildCompactionSentinel } from "../utils/compactionSentinel";
import { pickMeterUsageFromResult } from "./pickMeterUsageFromResult";
import {
  applyCommandLineEvent,
  approvalDetailValue,
  extractAssistantMessageParts,
} from "./useAgentStreamLogic";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const CODEX_COMMAND_APPROVAL_TOOL = "CodexCommandApproval";
const CODEX_FILE_CHANGE_APPROVAL_TOOL = "CodexFileChangeApproval";
const CODEX_PERMISSIONS_APPROVAL_TOOL = "CodexPermissionsApproval";

function isCodexApprovalTool(toolName: string): boolean {
  return (
    toolName === CODEX_COMMAND_APPROVAL_TOOL ||
    toolName === CODEX_FILE_CHANGE_APPROVAL_TOOL ||
    toolName === CODEX_PERMISSIONS_APPROVAL_TOOL
  );
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function addDetail(
  details: AgentApproval["details"],
  labelKey: AgentApprovalDetail["labelKey"],
  value: unknown,
) {
  const formatted = approvalDetailValue(value);
  if (formatted) details.push({ labelKey, value: formatted });
}

function parseCodexApproval(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): AgentApproval | null {
  const kind = stringField(input, "codexApprovalKind") as AgentApprovalKind | null;
  const details: AgentApproval["details"] = [];
  const baseApproval = {
    sessionId,
    toolUseId,
    supportsDenyReason: false,
  };

  if (toolName === CODEX_COMMAND_APPROVAL_TOOL && kind === "commandExecution") {
    addDetail(details, "command", input.command);
    addDetail(details, "cwd", input.cwd);
    addDetail(details, "reason", input.reason);
    return {
      ...baseApproval,
      kind,
      details,
    };
  }

  if (toolName === CODEX_FILE_CHANGE_APPROVAL_TOOL && kind === "fileChange") {
    addDetail(details, "path", input.path ?? input.filePath ?? input.grantRoot);
    addDetail(details, "reason", input.reason);
    return {
      ...baseApproval,
      kind,
      details,
    };
  }

  if (toolName === CODEX_PERMISSIONS_APPROVAL_TOOL && kind === "permissions") {
    addDetail(details, "cwd", input.cwd);
    addDetail(details, "permissions", input.permissions);
    addDetail(details, "reason", input.reason);
    return {
      ...baseApproval,
      kind,
      details,
    };
  }

  return null;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

interface AgentHookEventPayload {
  workspace_id: string;
  chat_session_id: string;
  input: {
    hook_event_name?: string;
    agent_id?: string;
    agent_type?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    tool_use_id?: string;
    error?: string;
    last_assistant_message?: unknown;
    claudette_agent_final_result?: unknown;
    claudette_agent_thinking_blocks?: unknown;
  };
}

export function useAgentStream() {
  const appendStreamingContent = useAppStore((s) => s.appendStreamingContent);
  const setStreamingContent = useAppStore((s) => s.setStreamingContent);
  const setPendingTypewriter = useAppStore((s) => s.setPendingTypewriter);
  const appendStreamingThinking = useAppStore((s) => s.appendStreamingThinking);
  const clearStreamingThinking = useAppStore((s) => s.clearStreamingThinking);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToolActivity = useAppStore((s) => s.addToolActivity);
  const updateToolActivity = useAppStore((s) => s.updateToolActivity);
  const upsertAgentToolCall = useAppStore((s) => s.upsertAgentToolCall);
  const appendToolActivityInput = useAppStore(
    (s) => s.appendToolActivityInput
  );
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const updateChatSession = useAppStore((s) => s.updateChatSession);
  const setAgentQuestion = useAppStore((s) => s.setAgentQuestion);
  const setPlanApproval = useAppStore((s) => s.setPlanApproval);
  const setAgentApproval = useAppStore((s) => s.setAgentApproval);
  const finalizeTurn = useAppStore((s) => s.finalizeTurn);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const addCompactionEvent = useAppStore((s) => s.addCompactionEvent);

  // Per-session map: sessionId → (content-block index → tool entry). Two
  // concurrent sessions routinely reuse the same Anthropic content-block
  // indices, so a flat per-index map would let one session's tool ids
  // clobber the other's. Cleared on each session's ProcessExited (only
  // that session's slot — the rest stays intact).
  const blockToolMapRef = useRef<BlockToolMap>({});
  // Per-session turn-state bookkeeping (keyed by session_id).
  const turnMessageCountRef = useRef<Record<string, number>>({});
  const turnFinalizedRef = useRef<Record<string, boolean>>({});
  const turnCheckpointIdRef = useRef<Record<string, string | undefined>>({});
  const turnSawUsageRef = useRef<Record<string, boolean>>({});
  const planFilePathRef = useRef<Record<string, string>>({});
  const thinkingBlocksRef = useRef<Record<string, Set<number>>>({});
  const pendingAgentToolCallsRef = useRef<Record<string, AgentToolCall[]>>({});

  // Recompute the workspace-level `agent_status` from the current
  // per-session statuses plus active background tasks. Priority:
  //   - `Running` if ANY active session is Running.
  //   - `IdleWithBackground` if no session is Running but at least one
  //     active session has a background task in `starting`/`running`.
  //   - `Idle` otherwise.
  // Used as a sentinel (sidebar busy badges, tray icon, auto-updater
  // gating) — it is not displayed verbatim. Call this whenever a session
  // or background task transitions so the aggregate stays accurate even
  // with concurrent sessions and async task updates.
  const syncWorkspaceAgentStatus = (wsId: string) => {
    const state = useAppStore.getState();
    const sessions = state.sessionsByWorkspace[wsId] ?? [];
    const anyRunning = sessions.some(
      (s) => s.status === "Active" && s.agent_status === "Running",
    );
    const activeSessionIds = new Set(
      sessions.filter((s) => s.status === "Active").map((s) => s.id),
    );
    const anyBackground = Object.entries(state.agentBackgroundTasksBySessionId)
      .some(([sessionId, tabs]) =>
        activeSessionIds.has(sessionId) &&
        tabs.some((tab) => {
          const status = (tab.task_status ?? "").toLowerCase();
          return status === "starting" || status === "running";
        }),
      );
    state.updateWorkspace(wsId, {
      agent_status: anyRunning
        ? "Running"
        : anyBackground
          ? "IdleWithBackground"
          : "Idle",
    });
  };

  useEffect(() => {
    // Guard against StrictMode double-mount: the async unlisten() promise
    // can't block React's synchronous remount, so a stale listener may
    // briefly coexist with the new one. This flag prevents the stale
    // listener from processing events.
    let active = true;
    const unlisten = listen<AgentStreamPayload>("agent-stream", (event) => {
      if (!active) return;
      const { workspace_id: wsId, chat_session_id: sessionId, event: agentEvent } =
        event.payload;

      if ("ProcessExited" in agentEvent) {
        debugChat("stream", "ProcessExited", {
          wsId,
          sessionId,
          alreadyFinalized: !!turnFinalizedRef.current[sessionId],
          checkpointId: turnCheckpointIdRef.current[sessionId] ?? null,
          pendingMessageCount: turnMessageCountRef.current[sessionId] || 0,
          pendingToolCount: (useAppStore.getState().toolActivities[sessionId] || []).length,
        });
        // Only finalize if the `result` event hasn't already done so.
        const wasFinalized = turnFinalizedRef.current[sessionId];
        if (!wasFinalized) {
          finalizeTurn(
            sessionId,
            turnMessageCountRef.current[sessionId] || 0,
            turnCheckpointIdRef.current[sessionId]
          );
        }
        turnMessageCountRef.current[sessionId] = 0;
        turnFinalizedRef.current[sessionId] = false;
        turnCheckpointIdRef.current[sessionId] = undefined;
        turnSawUsageRef.current[sessionId] = false;
        // Natural completion emits a `result` event (wasFinalized=true) → Idle.
        // User stop or crash has no prior `result` → Stopped.
        updateChatSession(sessionId, { agent_status: wasFinalized ? "Idle" : "Stopped" });
        syncWorkspaceAgentStatus(wsId);
        useAppStore.getState().clearPromptStartTime(wsId);
        setStreamingContent(sessionId, "");
        clearStreamingThinking(sessionId);
        clearBlockToolsForSession(blockToolMapRef.current, sessionId);
        delete thinkingBlocksRef.current[sessionId];
        // NOTE: Do NOT clear agentQuestion here. In --print mode the CLI
        // exits immediately after emitting AskUserQuestion, so ProcessExited
        // fires before the user has a chance to answer. The question is
        // cleared when the user responds (onRespond) or sends a new message.

        // Notification sound + command are handled on the Rust side
        // (in ProcessExited handler) so they work even when the webview
        // is suspended (window hidden / close-to-tray).

        return;
      }

      if (!("Stream" in agentEvent)) return;
      const streamEvent = agentEvent.Stream;

      // Handle different stream event types based on the Rust enum serialization
      if ("type" in streamEvent) {
        switch (streamEvent.type) {
          case "system": {
            if (streamEvent.subtype === "command_line") {
              const store = useAppStore.getState();
              const handled = applyCommandLineEvent(
                streamEvent,
                sessionId,
                {
                  getCurrent: (id) =>
                    store.sessionsByWorkspace[wsId]?.find(
                      (cs) => cs.id === id,
                    )?.cli_invocation ?? null,
                  updateSession: (id, line) =>
                    store.updateChatSession(id, { cli_invocation: line }),
                  persist: setSessionCliInvocation,
                },
              );
              if (handled) break;
            }
            if (
              (streamEvent.subtype === "task_started" ||
                streamEvent.subtype === "task_progress" ||
                streamEvent.subtype === "task_notification") &&
              streamEvent.tool_use_id
            ) {
              const updates: Parameters<typeof updateToolActivity>[2] = {};
              if (streamEvent.task_id) updates.agentTaskId = streamEvent.task_id;
              if (streamEvent.description || streamEvent.summary) {
                updates.agentDescription =
                  streamEvent.description ?? streamEvent.summary ?? null;
              }
              if (streamEvent.last_tool_name) {
                updates.agentLastToolName = streamEvent.last_tool_name;
              }
              if (typeof streamEvent.usage?.tool_uses === "number") {
                updates.agentToolUseCount = streamEvent.usage.tool_uses;
              }
              if (streamEvent.status) {
                updates.agentStatus = streamEvent.status;
              } else if (streamEvent.subtype === "task_progress") {
                updates.agentStatus = "running";
              }
              updateToolActivity(sessionId, streamEvent.tool_use_id, updates);
              if (streamEvent.task_id) {
                const pending = pendingAgentToolCallsRef.current[streamEvent.task_id] || [];
                const remaining = pending.filter(
                  (call) => !upsertAgentToolCall(sessionId, streamEvent.task_id!, call),
                );
                if (remaining.length > 0) {
                  pendingAgentToolCallsRef.current[streamEvent.task_id] = remaining;
                } else {
                  delete pendingAgentToolCallsRef.current[streamEvent.task_id];
                }
              }
            }
            // Compaction lifecycle: status -> "compacting" marks start;
            // compact_boundary marks end.
            if (
              streamEvent.subtype === "status" &&
              streamEvent.status === "compacting"
            ) {
              updateWorkspace(wsId, { agent_status: "Compacting" });
              break;
            }
            if (
              streamEvent.subtype === "compact_boundary" &&
              streamEvent.compact_metadata
            ) {
              const m = streamEvent.compact_metadata;
              const store = useAppStore.getState();
              const afterMessageIndex = (store.chatMessages[sessionId] ?? []).length;

              addCompactionEvent(sessionId, {
                timestamp: new Date().toISOString(),
                trigger: m.trigger,
                preTokens: m.pre_tokens,
                postTokens: m.post_tokens,
                durationMs: m.duration_ms,
                afterMessageIndex,
              });

              // The Tauri bridge persists a COMPACTION sentinel
              // ChatMessage to the DB but does NOT emit it as a live
              // stream event. Synthesize a matching message locally so
              // ChatPanel's sentinel dispatch renders the divider
              // immediately. The DB row uses a different UUID; on
              // workspace reload the DB version replaces this live
              // copy transparently.
              const sentinel = buildCompactionSentinel({
                trigger: m.trigger,
                preTokens: m.pre_tokens,
                postTokens: m.post_tokens,
                durationMs: m.duration_ms,
              });
              const liveSentinel: ChatMessage = {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                chat_session_id: sessionId,
                role: "System",
                content: sentinel,
                cost_usd: null,
                duration_ms: null,
                created_at: new Date().toISOString(),
                thinking: null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: m.post_tokens,
                cache_creation_tokens: null,
              };
              store.addChatMessage(sessionId, liveSentinel);

              // Drop the ContextMeter to the post-compaction baseline
              // during the live session. Zeros (not undefined) keep
              // `computeMeterState` from hiding the meter — the CLI has
              // reset the working context, so showing 0+postTokens+0
              // reflects the actual post-compaction state.
              store.setLatestTurnUsage(sessionId, {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: m.post_tokens,
                cacheCreationTokens: undefined,
              });

              updateWorkspace(wsId, { agent_status: "Running" });
              break;
            }
            // Other system subtypes (init, hook_*, etc.) — no action.
            break;
          }
          case "stream_event": {
            const inner = streamEvent.event;
            if ("type" in inner) {
              switch (inner.type) {
                case "message_delta": {
                  // Live meter update during streaming. Usage here is
                  // per-assistant-message cumulative — input_tokens reflects
                  // the prompt size for the current API call (grows across
                  // tool-use iterations as context accumulates), and
                  // output_tokens grows as the model generates. The `result`
                  // event later overwrites this with iterations[0] for the
                  // canonical per-call end-of-turn reading; this case just
                  // fills the gap in between so the meter doesn't sit stale.
                  if (inner.usage) {
                    const { setLatestTurnUsage } = useAppStore.getState();
                    turnSawUsageRef.current[sessionId] = true;
                    setLatestTurnUsage(sessionId, {
                      totalTokens: inner.usage.total_tokens ?? undefined,
                      inputTokens: inner.usage.input_tokens,
                      outputTokens: inner.usage.output_tokens,
                      cacheReadTokens:
                        inner.usage.cache_read_input_tokens ?? undefined,
                      cacheCreationTokens:
                        inner.usage.cache_creation_input_tokens ?? undefined,
                      modelContextWindow:
                        inner.usage.model_context_window ?? undefined,
                    });
                  }
                  break;
                }
                case "content_block_delta": {
                  const delta = inner.delta;
                  if ("type" in delta && delta.type === "text_delta") {
                    appendStreamingContent(sessionId, delta.text);
                  }
                  if (
                    "type" in delta &&
                    delta.type === "input_json_delta" &&
                    delta.partial_json
                  ) {
                    const entry = getBlockTool(
                      blockToolMapRef.current,
                      sessionId,
                      inner.index,
                    );
                    if (entry) {
                      appendToolActivityInput(
                        sessionId,
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
                    const entry = getBlockTool(
                      blockToolMapRef.current,
                      sessionId,
                      inner.index,
                    );
                    if (entry) {
                      appendToolActivityInput(
                        sessionId,
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
                    appendStreamingThinking(sessionId, delta.thinking);
                  }
                  break;
                }
                case "content_block_start": {
                  if (
                    inner.content_block &&
                    "type" in inner.content_block &&
                    inner.content_block.type === "thinking"
                  ) {
                    (thinkingBlocksRef.current[sessionId] ??= new Set()).add(inner.index);
                    // Clear previous thinking — new turn's thinking replaces old.
                    clearStreamingThinking(sessionId);
                  }
                  if (
                    inner.content_block &&
                    "type" in inner.content_block &&
                    inner.content_block.type === "tool_use"
                  ) {
                    setBlockTool(
                      blockToolMapRef.current,
                      sessionId,
                      inner.index,
                      {
                        toolUseId: inner.content_block.id,
                        toolName: inner.content_block.name,
                      },
                    );
                    addToolActivity(sessionId, {
                      toolUseId: inner.content_block.id,
                      toolName: inner.content_block.name,
                      inputJson: "",
                      resultText: "",
                      collapsed: true,
                      summary: "",
                      startedAt: new Date().toISOString(),
                      assistantMessageOrdinal:
                        (turnMessageCountRef.current[sessionId] || 0) +
                        ((useAppStore.getState().streamingContent[sessionId] || "")
                          .trim().length > 0
                          ? 1
                          : 0),
                    });
                    // Detect plan mode changes from agent tool calls.
                    if (inner.content_block.name === "EnterPlanMode") {
                      setPlanMode(sessionId, true);
                    } else if (inner.content_block.name === "ExitPlanMode") {
                      debugChat("plan-mode", "ExitPlanMode → setPlanMode(false)", { sessionId, origin: "content_block_start" });
                      setPlanMode(sessionId, false);
                    }
                  }
                  break;
                }
                case "content_block_stop": {
                  if (thinkingBlocksRef.current[sessionId]?.has(inner.index)) {
                    thinkingBlocksRef.current[sessionId].delete(inner.index);
                    break;
                  }
                  const entry = getBlockTool(
                    blockToolMapRef.current,
                    sessionId,
                    inner.index,
                  );
                  if (!entry) break;

                  // Read accumulated input JSON from the tool activity.
                  const activities =
                    useAppStore.getState().toolActivities[sessionId] || [];
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
                      updateToolActivity(sessionId, entry.toolUseId, { summary });
                    }
                  }

                  // NOTE: AskUserQuestion / ExitPlanMode card-showing is no
                  // longer driven by content_block_stop. The Rust bridge emits
                  // an `agent-permission-prompt` event the moment the CLI's
                  // `control_request` is captured (and pending_permissions is
                  // populated). The listener below handles those tools — that
                  // way the card cannot be clicked before the Rust side is
                  // ready to receive the answer.
                  break;
                }
              }
            }
            break;
          }
          case "assistant": {
            // Full message received — it's already persisted by the backend.
            // The CLI may fire multiple assistant events per turn: one with
            // thinking blocks only (no text), then one with text. We only
            // add a message and clear thinking when we have actual text.
            const { text, thinking } = extractAssistantMessageParts(
              streamEvent.message.content,
            );
            if (text) {
              turnMessageCountRef.current[sessionId] =
                (turnMessageCountRef.current[sessionId] || 0) + 1;
              debugChat("stream", "assistant", {
                sessionId,
                textLength: text.length,
                turnMessageCount: turnMessageCountRef.current[sessionId],
              });
              const messageId = crypto.randomUUID();
              // Latch the final text for the typewriter so StreamingMessage
              // can keep draining after streamingContent clears. The matching
              // messageId tells MessagesWithTurns to hide the just-added
              // completed message until drain finishes.
              setPendingTypewriter(sessionId, messageId, text);
              addChatMessage(sessionId, {
                id: messageId,
                workspace_id: wsId,
                chat_session_id: sessionId,
                role: "Assistant",
                content: text,
                cost_usd: null,
                duration_ms: null,
                created_at: new Date().toISOString(),
                thinking:
                  useAppStore.getState().streamingThinking[sessionId] ||
                  thinking ||
                  null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_creation_tokens: null,
              });
              // streamingThinking is NOT cleared here — StreamingThinkingBlock
              // needs to keep rendering through the typewriter drain so the
              // block doesn't vanish between streamingContent clearing and the
              // completed message unhiding. It's cleared atomically with
              // pendingTypewriter at drain-complete via finishTypewriterDrain.
            }
            setStreamingContent(sessionId, "");
            break;
          }
          case "result": {
            debugChat("stream", "result", {
              sessionId,
              checkpointId: turnCheckpointIdRef.current[sessionId] ?? null,
              pendingMessageCount: turnMessageCountRef.current[sessionId] || 0,
              pendingToolCount: (useAppStore.getState().toolActivities[sessionId] || []).length,
            });
            // CompletedTurn / TurnFooter keep aggregate semantics — the
            // top-level `result.usage.*` is the total cost/work across
            // all inner tool-use iterations in this Claudette-level turn.
            finalizeTurn(
              sessionId,
              turnMessageCountRef.current[sessionId] || 0,
              turnCheckpointIdRef.current[sessionId],
              streamEvent.duration_ms,
              streamEvent.usage?.input_tokens,
              streamEvent.usage?.output_tokens,
              streamEvent.usage?.cache_read_input_tokens ?? undefined,
              streamEvent.usage?.cache_creation_input_tokens ?? undefined,
            );
            const meterUsage = pickMeterUsageFromResult(streamEvent);
            const { setLatestTurnUsage, clearLatestTurnUsage } =
              useAppStore.getState();
            if (meterUsage) setLatestTurnUsage(sessionId, meterUsage);
            else if (!turnSawUsageRef.current[sessionId]) clearLatestTurnUsage(sessionId);
            turnMessageCountRef.current[sessionId] = 0;
            turnFinalizedRef.current[sessionId] = true;
            turnSawUsageRef.current[sessionId] = false;
            updateChatSession(sessionId, { agent_status: "Idle" });
            syncWorkspaceAgentStatus(wsId);
            useAppStore.getState().clearPromptStartTime(wsId);
            useAppStore.getState().markWorkspaceAsUnread(wsId);
            break;
          }
          case "user": {
            // Tool results — update matching tool activities and extract
            // plan file path from EnterPlanMode results.
            const planPathRe = /(\/[^\s)"`]+\/\.claude\/plans\/[^\s)"`]+\.md)/;
            const blocks = Array.isArray(streamEvent.message.content)
              ? streamEvent.message.content
              : [];
            for (const block of blocks) {
              if (block.type === "tool_result") {
                const text =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                updateToolActivity(sessionId, block.tool_use_id, {
                  resultText: text,
                });
                // Capture plan file path from tool results (e.g. EnterPlanMode).
                const pm = text.match(planPathRe);
                if (pm) planFilePathRef.current[sessionId] = pm[1];
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
    setPendingTypewriter,
    addToolActivity,
    updateToolActivity,
    appendToolActivityInput,
    updateWorkspace,
    setAgentQuestion,
    setPlanApproval,
    upsertAgentToolCall,
    finalizeTurn,
    setPlanMode,
    addCompactionEvent,
    updateChatSession,
  ]);

  useEffect(() => {
    let active = true;
    const unlisten = listen<AgentHookEventPayload>("agent-hook-event", (event) => {
      if (!active) return;
      const { chat_session_id: sessionId, input } = event.payload;
      const agentId = input.agent_id;
      const hookName = input.hook_event_name;
      if (!agentId || !hookName) return;

      if (hookName === "SubagentStart") {
        const pending = pendingAgentToolCallsRef.current[agentId] || [];
        const remaining = pending.filter((call) => !upsertAgentToolCall(sessionId, agentId, call));
        if (remaining.length > 0) {
          pendingAgentToolCallsRef.current[agentId] = remaining;
        } else {
          delete pendingAgentToolCallsRef.current[agentId];
        }
        return;
      }

      if (hookName === "SubagentStop") {
        const activity = (
          useAppStore.getState().toolActivities[sessionId] || []
        ).find(
          (item) =>
            item.agentTaskId === agentId ||
            item.toolUseId === input.tool_use_id ||
            item.toolUseId === agentId,
        );
        if (!activity) return;
        const finalResult =
          stringFromUnknown(input.last_assistant_message) ??
          stringFromUnknown(input.claudette_agent_final_result);
        const thinkingBlocks = stringArrayFromUnknown(
          input.claudette_agent_thinking_blocks,
        );
        const updates: Parameters<typeof updateToolActivity>[2] = {
          agentStatus: input.error ? "failed" : "completed",
        };
        if (finalResult) updates.agentResultText = finalResult;
        if (thinkingBlocks.length > 0) {
          updates.agentThinkingBlocks = thinkingBlocks;
        }
        updateToolActivity(sessionId, activity.toolUseId, updates);
        return;
      }

      if (
        hookName !== "PreToolUse" &&
        hookName !== "PostToolUse" &&
        hookName !== "PostToolUseFailure"
      ) {
        return;
      }

      const toolUseId = input.tool_use_id;
      const toolName = input.tool_name;
      if (!toolUseId || !toolName) return;

      const now = new Date().toISOString();
      const call: AgentToolCall = {
        toolUseId,
        toolName,
        agentId,
        agentType: input.agent_type ?? null,
        input: input.tool_input,
        response: input.tool_response,
        error: input.error ?? null,
        status:
          hookName === "PostToolUseFailure"
            ? "failed"
            : hookName === "PostToolUse"
              ? "completed"
              : "running",
        startedAt: now,
        completedAt: hookName === "PreToolUse" ? null : now,
      };

      if (!upsertAgentToolCall(sessionId, agentId, call)) {
        pendingAgentToolCallsRef.current[agentId] = [
          ...(pendingAgentToolCallsRef.current[agentId] || []).filter(
            (item) => item.toolUseId !== toolUseId,
          ),
          call,
        ];
      }
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [upsertAgentToolCall, updateToolActivity]);

  // Listen for `agent-permission-prompt` — emitted by the Rust bridge the
  // moment a CLI `control_request: can_use_tool` is captured for
  // AskUserQuestion / ExitPlanMode and the corresponding pending_permissions
  // entry exists. Driving the card from this event (instead of the much
  // earlier `content_block_stop`) eliminates the race where the user could
  // click before the Rust side was ready to receive the answer.
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      workspace_id: string;
      chat_session_id: string;
      tool_use_id: string;
      tool_name: string;
      input: unknown;
    }>("agent-permission-prompt", (event) => {
      if (!active) return;
      const {
        chat_session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        input,
      } = event.payload;
      if (toolName === ASK_USER_QUESTION_TOOL) {
        // The CLI guarantees `input` is the validated tool-input object —
        // narrow before handing it to the parser.
        if (input && typeof input === "object") {
          try {
            const questions = parseAskUserQuestion(input as Record<string, unknown>);
            if (questions.length > 0) {
              setAgentQuestion({ sessionId, toolUseId, questions });
              // Keep the ChatSession row in sync so the tab icon + sidebar
              // aggregate reflect the pending attention without a reload.
              updateChatSession(sessionId, {
                needs_attention: true,
                attention_kind: "Ask",
              });
            }
          } catch {
            // Malformed input — ignore (CLI will eventually time out and we
            // auto-deny on session cleanup).
          }
        }
      } else if (toolName === "ExitPlanMode") {
        // Mirror the content_block_start clear at the control_request boundary
        // in case that event arrived without the tool `name` populated.
        // Idempotent — setting to the same value is a no-op.
        debugChat("plan-mode", "ExitPlanMode → setPlanMode(false)", { sessionId, origin: "agent-permission-prompt" });
        setPlanMode(sessionId, false);
        let allowedPrompts: Array<{ tool: string; prompt: string }> = [];
        if (input && typeof input === "object" && "allowedPrompts" in input) {
          const ap = (input as { allowedPrompts?: unknown }).allowedPrompts;
          if (Array.isArray(ap)) {
            allowedPrompts = ap as Array<{ tool: string; prompt: string }>;
          }
        }
        // Reuse the same plan-file-path discovery the old content_block_stop
        // path used: assistant text, then streaming text, then tool inputs/
        // results, then the cached EnterPlanMode result path.
        const planPathRe = /(\/[^\s)"`]+\/\.claude\/plans\/[^\s)"`]+\.md)/;
        const messages = useAppStore.getState().chatMessages[sessionId] || [];
        let planFilePath: string | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i].content.match(planPathRe);
          if (m) { planFilePath = m[1]; break; }
        }
        if (!planFilePath) {
          const streaming = useAppStore.getState().streamingContent[sessionId] || "";
          const m = streaming.match(planPathRe);
          if (m) planFilePath = m[1];
        }
        if (!planFilePath) {
          const allActivities = useAppStore.getState().toolActivities[sessionId] || [];
          for (const act of allActivities) {
            const m = (act.inputJson + act.resultText).match(planPathRe);
            if (m) { planFilePath = m[1]; break; }
          }
        }
        if (!planFilePath && planFilePathRef.current[sessionId]) {
          planFilePath = planFilePathRef.current[sessionId];
        }
        setPlanApproval({ sessionId, toolUseId, planFilePath, allowedPrompts });
        updateChatSession(sessionId, {
          needs_attention: true,
          attention_kind: "Plan",
        });
      } else if (isCodexApprovalTool(toolName)) {
        if (input && typeof input === "object") {
          const approval = parseCodexApproval(
            sessionId,
            toolUseId,
            toolName,
            input as Record<string, unknown>,
          );
          if (approval) {
            setAgentApproval(approval);
            updateChatSession(sessionId, {
              needs_attention: true,
              attention_kind: "Ask",
            });
          }
        }
      }
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [setAgentApproval, setAgentQuestion, setPlanApproval, setPlanMode, updateChatSession]);

  // Listen for checkpoint-created events from the backend.
  const addCheckpoint = useAppStore((s) => s.addCheckpoint);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      workspace_id: string;
      chat_session_id: string;
      checkpoint: ConversationCheckpoint;
    }>("checkpoint-created", (event) => {
      if (!active) return;
      const { chat_session_id: sessionId, checkpoint } = event.payload;
      addCheckpoint(sessionId, checkpoint);
      turnCheckpointIdRef.current[sessionId] = checkpoint.id;

      // Persist tool activities for the just-completed turn, then reload
      // messages so the store has DB-persisted IDs. The save MUST complete
      // before any subsequent loadCompletedTurns() reads, otherwise the DB
      // snapshot will be stale and overwrite the in-memory turns.
      // NOTE: checkpoint-created fires BEFORE the agent-stream result event,
      // so finalizeTurn() hasn't run yet. Read from toolActivities (pre-
      // finalization) and turnMessageCountRef instead of completedTurns.
      const currentActivities = useAppStore.getState().toolActivities[sessionId] || [];
      debugChat("stream", "checkpoint-created", {
        sessionId,
        checkpointId: checkpoint.id,
        checkpointMessageId: checkpoint.message_id,
        turnIndex: checkpoint.turn_index,
        currentToolCount: currentActivities.length,
        pendingMessageCount: turnMessageCountRef.current[sessionId] || 0,
      });
      const savePromise = currentActivities.length > 0
        ? (() => {
            const messageCount = turnMessageCountRef.current[sessionId] || 0;
            const activities = currentActivities.map((a, i) => ({
              id: crypto.randomUUID(),
              checkpoint_id: checkpoint.id,
              tool_use_id: a.toolUseId,
              tool_name: a.toolName,
              input_json: a.inputJson,
              result_text: a.resultText,
              summary: a.summary,
              sort_order: i,
              assistant_message_ordinal: a.assistantMessageOrdinal ?? 0,
              agent_task_id: a.agentTaskId ?? null,
              agent_description: a.agentDescription ?? null,
              agent_last_tool_name: a.agentLastToolName ?? null,
              agent_tool_use_count: a.agentToolUseCount ?? null,
              agent_status: a.agentStatus ?? null,
              agent_tool_calls_json: JSON.stringify(a.agentToolCalls ?? []),
              agent_thinking_blocks_json: JSON.stringify(
                a.agentThinkingBlocks ?? [],
              ),
              agent_result_text: a.agentResultText ?? null,
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
            sessionId,
            checkpointId: checkpoint.id,
          });
        })
        .catch((e) => {
          console.error("Failed to save turn tool activities:", e);
          debugChat("stream", "checkpoint-save-failed", {
            sessionId,
            checkpointId: checkpoint.id,
            error: String(e),
          });
        })
        .then(() => loadChatHistory(sessionId))
        .then((msgs) => {
          if (!msgs) return;
          const filtered = msgs.filter(
            (m: ChatMessage) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking,
          );
          debugChat("stream", "checkpoint-reload-chat-history", {
            sessionId,
            checkpointId: checkpoint.id,
            messageCount: filtered.length,
            messageIds: filtered.map((msg) => msg.id),
          });
          setChatMessages(sessionId, filtered);
          const callUsage = extractLatestCallUsage(filtered);
          const { setLatestTurnUsage, clearLatestTurnUsage } =
            useAppStore.getState();
          if (callUsage) setLatestTurnUsage(sessionId, callUsage);
          // Preserve the just-emitted result.usage when the CLI does not also
          // write token metadata onto assistant messages (observed with
          // Claude Code gateway backends). Initial history loads still clear
          // stale meter state when no persisted token data exists.
          else if (!useAppStore.getState().latestTurnUsage[sessionId]) {
            clearLatestTurnUsage(sessionId);
          }
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

  // Listen for session-renamed events. The backend emits this from
  // `try_generate_session_name` after Haiku produces a short label
  // for the first user prompt — the same flow that renames the
  // workspace. Without this listener the chat tab kept its `New chat`
  // placeholder until the user switched workspaces and came back, at
  // which point `SessionTabs`' mount effect re-fetched the session
  // list and the renamed value finally surfaced. Mirroring the
  // workspace-renamed handler closes that gap so the tab updates
  // live.
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      session_id: string;
      name: string;
    }>("session-renamed", (event) => {
      if (!active) return;
      const { session_id, name } = event.payload;
      updateChatSession(session_id, { name });
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [updateChatSession]);

  // Listen for backend-authored system messages that the chat command
  // inserts into the DB out-of-band (currently: env-provider trust
  // warnings emitted before agent spawn). The DB insert keeps the
  // message in history; this event mirrors it into the live store so
  // the user sees it immediately, not only after the failing turn
  // finalizes and triggers a history reload.
  useEffect(() => {
    let active = true;
    const unlisten = listen<ChatMessage>("chat-system-message", (event) => {
      if (!active) return;
      addChatMessage(event.payload.chat_session_id, event.payload);
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [addChatMessage]);

  // Backend-authored chat messages that are not tied to the normal GUI send
  // path. Claude Remote Control uses this for remote-origin user prompts.
  useEffect(() => {
    let active = true;
    const unlisten = listen<ChatMessage>("chat-message", (event) => {
      if (!active) return;
      addChatMessage(event.payload.chat_session_id, event.payload);
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [addChatMessage]);

  // Listen for agent-authored attachments delivered via the
  // `mcp__claudette__send_to_user` tool. The Rust bridge has already
  // persisted them; we just need to mirror into the in-memory store so the
  // chat surface re-renders. Reuses the existing user-attachment shape +
  // rendering — origin: "agent" lets future code distinguish if needed.
  const addChatAttachments = useAppStore((s) => s.addChatAttachments);
  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      workspace_id: string;
      chat_session_id: string;
      message_id: string;
      attachment: {
        id: string;
        message_id: string;
        filename: string;
        media_type: string;
        size_bytes: number;
        width: number | null;
        height: number | null;
        tool_use_id: string | null;
        data_base64: string;
        caption?: string | null;
      };
    }>("agent-attachment-created", (event) => {
      if (!active) return;
      // Store keys `chatAttachments` by chat_session_id (a single workspace
      // can have several sessions), so we route by that. workspace_id is
      // present too but unused here.
      const { chat_session_id: sessionId, attachment } = event.payload;
      addChatAttachments(sessionId, [
        {
          id: attachment.id,
          message_id: attachment.message_id,
          filename: attachment.filename,
          media_type: attachment.media_type,
          data_base64: attachment.data_base64,
          text_content: null,
          width: attachment.width,
          height: attachment.height,
          size_bytes: attachment.size_bytes,
          origin: "agent",
          tool_use_id: attachment.tool_use_id,
        },
      ]);
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [addChatAttachments]);

  useEffect(() => {
    let active = true;
    const unlisten = listen<{
      kind: "starting" | "bound" | "status";
      workspace_id: string;
      chat_session_id: string;
      tab: TerminalTab;
    }>("agent-background-task", (event) => {
      if (!active) return;
      const { workspace_id: wsId, chat_session_id: sessionId, tab } = event.payload;
      const store = useAppStore.getState();
      store.upsertAgentTaskTerminalTab(wsId, sessionId, tab);
      const nextState = useAppStore.getState();
      const session = (nextState.sessionsByWorkspace[wsId] ?? []).find(
        (s) => s.id === sessionId,
      );
      if (session?.agent_status !== "Running") {
        const hasRunningBackground = (
          nextState.agentBackgroundTasksBySessionId[sessionId] ?? []
        ).some((taskTab) => {
          const status = (taskTab.task_status ?? "").toLowerCase();
          return status === "starting" || status === "running";
        });
        nextState.updateChatSession(sessionId, {
          agent_status: hasRunningBackground ? "IdleWithBackground" : "Idle",
        });
      }
      syncWorkspaceAgentStatus(wsId);
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, []);
}
