import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import { selfParticipantIdForWorkspace } from "./useSelfParticipantId";
import {
  collaborationSessionSnapshot,
  loadChatHistory,
  saveTurnToolActivities,
  sendRemoteCommand,
  setSessionCliInvocation,
} from "../services/tauri";
import type { AgentStreamPayload } from "../types/agent-events";
import type { AgentToolCall } from "../stores/useAppStore";
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
import { applyCommandLineEvent } from "./useAgentStreamLogic";
import { isRemoteCheckpointWorkspace } from "./checkpointWorkspace";
import { applyRemoteJoinSessionSnapshot } from "../components/chat/remoteJoinSessionSnapshot";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

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
  const finalizeTurn = useAppStore((s) => s.finalizeTurn);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setPromptStartTime = useAppStore((s) => s.setPromptStartTime);
  const clearPromptStartTime = useAppStore((s) => s.clearPromptStartTime);
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

      const streamEvent = agentEvent.Stream;
      if (!streamEvent) return;

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
                cache_creation_tokens: null, author_participant_id: null, author_display_name: null,
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
                    setLatestTurnUsage(sessionId, {
                      inputTokens: inner.usage.input_tokens,
                      outputTokens: inner.usage.output_tokens,
                      cacheReadTokens:
                        inner.usage.cache_read_input_tokens ?? undefined,
                      cacheCreationTokens:
                        inner.usage.cache_creation_input_tokens ?? undefined,
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
            const text = streamEvent.message.content
              .filter(
                (b): b is { type: "text"; text: string } => b.type === "text"
              )
              .map((b) => b.text)
              .join("");
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
                  useAppStore.getState().streamingThinking[sessionId] || null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_creation_tokens: null, author_participant_id: null, author_display_name: null,
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
            else clearLatestTurnUsage(sessionId);
            turnMessageCountRef.current[sessionId] = 0;
            turnFinalizedRef.current[sessionId] = true;
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
  }, [upsertAgentToolCall]);

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
      required_voters?: import("../stores/slices/collabSlice").Participant[];
    }>("agent-permission-prompt", (event) => {
      if (!active) return;
      const {
        chat_session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        input,
        required_voters: requiredVoters,
      } = event.payload;
      if (toolName === ASK_USER_QUESTION_TOOL) {
        // The CLI guarantees `input` is the validated tool-input object —
        // narrow before handing it to the parser.
        if (input && typeof input === "object") {
          try {
            const questions = parseAskUserQuestion(input as Record<string, unknown>);
            if (questions.length > 0) {
              setAgentQuestion({
                sessionId,
                toolUseId,
                questions,
                requiredVoters: Array.isArray(requiredVoters)
                  ? requiredVoters
                  : undefined,
                votes: {},
              });
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
      }
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [setAgentQuestion, setPlanApproval, setPlanMode, updateChatSession]);

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
      const { workspace_id: wsId, chat_session_id: sessionId, checkpoint } = event.payload;
      addCheckpoint(sessionId, checkpoint);
      turnCheckpointIdRef.current[sessionId] = checkpoint.id;
      const isRemoteWorkspace = isRemoteCheckpointWorkspace(
        useAppStore.getState().workspaces,
        wsId,
      );

      // Persist tool activities for the just-completed turn, then reload
      // messages so the store has DB-persisted IDs. The save MUST complete
      // before any subsequent loadCompletedTurns() reads, otherwise the DB
      // snapshot will be stale and overwrite the in-memory turns.
      // NOTE: checkpoint-created fires BEFORE the agent-stream result event,
      // so finalizeTurn() hasn't run yet. Read from toolActivities (pre-
      // finalization) and turnMessageCountRef instead of completedTurns.
      const currentActivities = useAppStore.getState().toolActivities[sessionId] || [];
      debugChat("stream", "checkpoint-created", {
        wsId,
        sessionId,
        checkpointId: checkpoint.id,
        checkpointMessageId: checkpoint.message_id,
        turnIndex: checkpoint.turn_index,
        currentToolCount: currentActivities.length,
        pendingMessageCount: turnMessageCountRef.current[sessionId] || 0,
        isRemoteWorkspace,
      });

      if (isRemoteWorkspace) {
        debugChat("stream", "checkpoint-local-persistence-skipped-remote", {
          wsId,
          sessionId,
          checkpointId: checkpoint.id,
        });
        return;
      }
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

  // Listen for collaborative user-message broadcasts. The bridge (both
  // server-side handler.rs and Tauri-side chat/send.rs) publishes
  // `chat-message-added` to the room when a user message is persisted in
  // a collaborative session, so other participants render it live.
  // Sender-side dedupe: skip when the message's author_participant_id
  // matches the local user's selfParticipantId for that workspace —
  // the sender already rendered it optimistically and broadcasting back
  // would otherwise produce a duplicate row.
  //
  // Note on the rare hydration race: if the broadcast arrives before
  // `workspaces` / `remoteConnections` are populated, `selfPid` resolves
  // to `null` and the dedupe is skipped — so the sender briefly sees a
  // duplicate. In practice this only happens on cold-boot when an
  // already-running collab session immediately fires; the optimistic UI
  // and the broadcast both target the same `addChatMessage` reducer so
  // the ordering is consistent even when dedupe fails.
  useEffect(() => {
    let active = true;
    const unlisten = listen<ChatMessage>("chat-message-added", (event) => {
      if (!active) return;
      const msg = event.payload;
      const selfPid = selfParticipantIdForWorkspace(
        useAppStore.getState(),
        msg.workspace_id,
      );
      if (msg.author_participant_id && selfPid && msg.author_participant_id === selfPid) {
        return;
      }
      addChatMessage(msg.chat_session_id, msg);
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

  // -- Collaborative-session events --
  //
  // The host process re-emits broadcast room events to the local webview;
  // remote clients receive the same events directly over the WebSocket and
  // through the existing remote-event forwarder.
  //
  // Five events funnel into store mutations:
  //   - participants-changed: refresh the per-session roster
  //   - turn-started / turn-ended: drive composer enable/disable
  //   - plan-vote-opened: open a consensus card
  //   - plan-vote-cast: record a vote
  //   - plan-vote-resolved: clear the consensus and approval cards
  const setParticipants = useAppStore((s) => s.setParticipants);
  const setTurnHolder = useAppStore((s) => s.setTurnHolder);
  const openConsensusVote = useAppStore((s) => s.openConsensusVote);
  const recordConsensusVote = useAppStore((s) => s.recordConsensusVote);
  const clearConsensusVote = useAppStore((s) => s.clearConsensusVote);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const recordAgentQuestionVote = useAppStore((s) => s.recordAgentQuestionVote);
  const setAgentQuestionSnapshot = useAppStore((s) => s.setAgentQuestion);
  useEffect(() => {
    let active = true;
    const applySnapshot = (sessionId: string, snapshot: unknown) => {
      const state = useAppStore.getState();
      const workspaceId = Object.entries(state.sessionsByWorkspace).find(
        ([, sessions]) => sessions.some((session) => session.id === sessionId),
      )?.[0];
      applyRemoteJoinSessionSnapshot(sessionId, snapshot, {
        setParticipants,
        setTurnHolder,
        openConsensusVote,
        recordConsensusVote,
        setPlanApproval,
        setPlanMode,
        setSelectedModel,
        setAgentQuestion: setAgentQuestionSnapshot,
        setPromptStartTime: (startedAtMs) => {
          if (workspaceId) setPromptStartTime(workspaceId, startedAtMs);
        },
      });
    };
    const resyncSession = async (sessionId: string) => {
      const state = useAppStore.getState();
      const workspaceEntry = Object.entries(state.sessionsByWorkspace).find(
        ([, sessions]) => sessions.some((session) => session.id === sessionId),
      );
      const workspaceId = workspaceEntry?.[0];
      const workspace = workspaceId
        ? state.workspaces.find((ws) => ws.id === workspaceId)
        : undefined;
      try {
        const snapshot = workspace?.remote_connection_id
          ? await sendRemoteCommand(workspace.remote_connection_id, "join_session", {
              chat_session_id: sessionId,
            })
          : await collaborationSessionSnapshot(sessionId);
        if (active) applySnapshot(sessionId, snapshot);
      } catch (e) {
        console.warn("collaboration resync failed:", e);
      }
    };
    const unlistenParticipants = listen<{
      chat_session_id: string;
      participants: import("../stores/slices/collabSlice").Participant[];
    }>("participants-changed", (event) => {
      if (!active) return;
      setParticipants(event.payload.chat_session_id, event.payload.participants);
    });
    const unlistenStarted = listen<{
      workspace_id?: string;
      chat_session_id: string;
      participant_id: string;
      display_name: string;
      started_at_ms?: number;
      model?: string | null;
      plan_mode?: boolean;
    }>("turn-started", (event) => {
      if (!active) return;
      const {
        workspace_id,
        chat_session_id,
        participant_id,
        display_name,
        started_at_ms,
        model,
        plan_mode,
      } = event.payload;
      setTurnHolder(chat_session_id, { participant_id, display_name });
      // Flip the per-session and per-workspace agent_status to "Running" so
      // every connected participant — not just the one that initiated the
      // turn — sees the spinner in their sidebar. The initiating side
      // already set this optimistically in the React layer; for everyone
      // else, this broadcast is the only signal.
      //
      // workspace_id is included by post-bdee038 bridges; older clients
      // may not send it. Fall back to looking up via sessionsByWorkspace
      // so we still update the session-level status either way.
      if (workspace_id) {
        useAppStore.getState().updateWorkspace(workspace_id, { agent_status: "Running" });
        if (typeof started_at_ms === "number" && started_at_ms > 0) {
          setPromptStartTime(workspace_id, started_at_ms);
        }
      }
      if (typeof model === "string" && model) {
        setSelectedModel(chat_session_id, model);
      }
      if (typeof plan_mode === "boolean") {
        setPlanMode(chat_session_id, plan_mode);
      }
      useAppStore.getState().updateChatSession(chat_session_id, { agent_status: "Running" });
    });
    const unlistenEnded = listen<{
      workspace_id?: string;
      chat_session_id: string;
    }>("turn-ended", (event) => {
      if (!active) return;
      if (event.payload.workspace_id) {
        clearPromptStartTime(event.payload.workspace_id);
      }
      setTurnHolder(event.payload.chat_session_id, null);
      // Note: we don't reset agent_status here — the agent-stream
      // ProcessExited handler is the canonical place for that and
      // distinguishes Idle vs. Stopped based on whether a `result`
      // event was seen. Both turn-ended and ProcessExited reach every
      // participant via the room broadcast, so the ProcessExited path
      // handles the post-turn state for everyone.
    });
    const unlistenOpened = listen<{
      chat_session_id: string;
      tool_use_id: string;
      required_voters: import("../stores/slices/collabSlice").Participant[];
    }>("plan-vote-opened", (event) => {
      if (!active) return;
      const { chat_session_id, tool_use_id, required_voters } = event.payload;
      openConsensusVote(chat_session_id, tool_use_id, required_voters);
    });
    const unlistenCast = listen<{
      chat_session_id: string;
      tool_use_id: string;
      participant_id: string;
      vote: import("../stores/slices/collabSlice").ParticipantVote;
    }>("plan-vote-cast", (event) => {
      if (!active) return;
      const { chat_session_id, tool_use_id, participant_id, vote } =
        event.payload;
      recordConsensusVote(chat_session_id, tool_use_id, participant_id, vote);
    });
    const unlistenResolved = listen<{ chat_session_id: string }>(
      "plan-vote-resolved",
      (event) => {
        if (!active) return;
        clearConsensusVote(event.payload.chat_session_id);
        clearPlanApproval(event.payload.chat_session_id);
      },
    );
    const unlistenQuestionResolved = listen<{ chat_session_id: string }>(
      "agent-question-resolved",
      (event) => {
        if (!active) return;
        clearAgentQuestion(event.payload.chat_session_id);
      },
    );
    const unlistenQuestionCast = listen<{
      chat_session_id: string;
      tool_use_id: string;
      participant_id: string;
      answers: Record<string, string>;
    }>("agent-question-answer-cast", (event) => {
      if (!active) return;
      const { chat_session_id, tool_use_id, participant_id, answers } =
        event.payload;
      recordAgentQuestionVote(
        chat_session_id,
        tool_use_id,
        participant_id,
        answers,
      );
    });
    const unlistenHistoryReplaced = listen<{
      workspace_id: string;
      chat_session_id: string;
      checkpoint_id: string | null;
      messages: import("../types/chat").ChatMessage[];
    }>("session-history-replaced", (event) => {
      if (!active) return;
      const {
        workspace_id,
        chat_session_id,
        checkpoint_id,
        messages,
      } = event.payload;
      useAppStore
        .getState()
        .rollbackConversation(
          chat_session_id,
          workspace_id,
          checkpoint_id ?? "__clear__",
          messages,
        );
    });
    const unlistenResyncRequired = listen<{
      chat_session_id?: string | null;
    } | null>("resync-required", (event) => {
      if (!active) return;
      const requestedSessionId = event.payload?.chat_session_id ?? null;
      const sessionIds = requestedSessionId
        ? [requestedSessionId]
        : Object.values(useAppStore.getState().sessionsByWorkspace)
            .flat()
            .map((session) => session.id);
      for (const sessionId of sessionIds) {
        void resyncSession(sessionId);
      }
    });
    return () => {
      active = false;
      unlistenParticipants.then((fn) => fn());
      unlistenStarted.then((fn) => fn());
      unlistenEnded.then((fn) => fn());
      unlistenOpened.then((fn) => fn());
      unlistenCast.then((fn) => fn());
      unlistenResolved.then((fn) => fn());
      unlistenQuestionCast.then((fn) => fn());
      unlistenQuestionResolved.then((fn) => fn());
      unlistenHistoryReplaced.then((fn) => fn());
      unlistenResyncRequired.then((fn) => fn());
    };
  }, [
    setParticipants,
    setTurnHolder,
    setPromptStartTime,
    setSelectedModel,
    setPlanMode,
    clearPromptStartTime,
    openConsensusVote,
    recordConsensusVote,
    setPlanApproval,
    clearConsensusVote,
    clearPlanApproval,
    clearAgentQuestion,
    recordAgentQuestionVote,
    setAgentQuestionSnapshot,
  ]);
}
