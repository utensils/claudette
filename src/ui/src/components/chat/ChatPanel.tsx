import React, { createContext, memo, useContext, useEffect, useRef, useState, useMemo, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { AnsiUp } from "ansi_up";
import { GitBranch, LayoutDashboard, RotateCcw } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity, CompletedTurn } from "../../stores/useAppStore";
import {
  loadChatHistory,
  listCheckpoints,
  loadCompletedTurns,
  listSlashCommands,
  recordSlashCommandUsage,
  sendChatMessage,
  sendRemoteCommand,
  stopAgent,
  getAppSetting,
  setAppSetting,
  listWorkspaceFiles,
} from "../../services/tauri";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import type { SlashCommand, FileEntry } from "../../services/tauri";
import type { ChatMessage } from "../../types/chat";
import { useAgentStream } from "../../hooks/useAgentStream";
import { extractToolSummary } from "../../hooks/toolSummary";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { ChatToolbar } from "./ChatToolbar";
import { WorkspaceActions } from "./WorkspaceActions";
import { HeaderMenu } from "./HeaderMenu";
import { SlashCommandPicker, filterSlashCommands } from "./SlashCommandPicker";
import { FileMentionPicker, matchFiles } from "./FileMentionPicker";
import { checkpointHasFileChanges, clearAllHasFileChanges, buildRollbackMap } from "../../utils/checkpointUtils";
import { ThinkingBlock } from "./ThinkingBlock";
import { PanelToggles } from "../shared/PanelToggles";
import { deriveTasks, processActivities, turnHasTaskActivity, hasTaskActivity } from "../../hooks/useTaskTracker";
import type { TaskTrackerResult, TrackedTask } from "../../hooks/useTaskTracker";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { debugChat } from "../../utils/chatDebug";
import styles from "./ChatPanel.module.css";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Shared AnsiUp instance for converting ANSI escape sequences to HTML.
const ansiUp = new AnsiUp();
ansiUp.use_classes = false;

/** Convert ANSI escape codes in text to HTML span tags. */
function ansiToHtml(text: string): string {
  // Only run conversion if the text actually contains escape sequences
  if (!text.includes("\x1b") && !text.includes("\u001b")) return text;
  return ansiUp.ansi_to_html(text);
}

/**
 * Pre-process Claude Code's decorative callout blocks into styled HTML.
 * Claude outputs patterns like:
 *   `★ Insight ─────────────────────────────────────`
 *   [content]
 *   `─────────────────────────────────────────────────`
 *
 * These look great in a terminal but render as inline <code> in markdown.
 * Convert them to block-level HTML elements that react-markdown + rehype-raw
 * will pass through as styled callout blocks.
 */
/**
 * Build callout header HTML, splitting a leading icon from the label text.
 * e.g. "★ Insight" → icon span + "Insight", "Warning" → just "Warning"
 */
function calloutHeader(rawLabel: string): string {
  const label = rawLabel.trim();
  const match = label.match(/^(\S)\s+(.*)/);
  if (match) {
    return `<span class="cc-callout-icon">${match[1]}</span> ${match[2]}`;
  }
  return label;
}

function preprocessCallouts(text: string): string {
  // Full callout blocks (backtick-wrapped): `Label ───` ... content ... `───`
  // [^─`] matches any character that isn't a dash or backtick — captures the label.
  text = text.replace(
    /`([^─`]+?)─{3,}`([\s\S]*?)`─{5,}`/g,
    (_m, label: string, content: string) =>
      `\n\n<div class="cc-callout"><div class="cc-callout-header">${calloutHeader(label)}</div>\n\n${content.trim()}\n\n</div>\n\n`,
  );

  // Full callout blocks (no backticks, standalone lines)
  text = text.replace(
    /^([^─\n]+?)─{3,}\s*$([\s\S]*?)^─{5,}\s*$/gm,
    (_m, label: string, content: string) =>
      `\n\n<div class="cc-callout"><div class="cc-callout-header">${calloutHeader(label)}</div>\n\n${content.trim()}\n\n</div>\n\n`,
  );

  // Leftover unmatched backtick-wrapped headers (no closing rule found)
  text = text.replace(
    /`([^─`]+?)─{3,}`/g,
    (_m, label: string) =>
      `\n\n<div class="cc-callout-header">${calloutHeader(label)}</div>\n\n`,
  );

  // Leftover unmatched backtick-wrapped horizontal rules
  text = text.replace(
    /`─{5,}`/g,
    '\n\n<hr class="cc-callout-rule" />\n\n',
  );

  return text;
}

/** Full pre-processing pipeline for assistant message content. */
function preprocessContent(text: string): string {
  return preprocessCallouts(ansiToHtml(text));
}

/** Semantic colors for tool names — makes tool activity scannable at a glance. */
const TOOL_COLORS: Record<string, string> = {
  Read: "#6cb6ff",
  Glob: "#6cb6ff",
  Grep: "#6cb6ff",
  Write: "#f0a050",
  Edit: "#e0c050",
  Bash: "#7ee07e",
  WebSearch: "#c0a0f0",
  WebFetch: "#c0a0f0",
  Agent: "#f08080",
  AskUserQuestion: "var(--accent-primary)",
};

function toolColor(name: string): string {
  return TOOL_COLORS[name] ?? "var(--text-muted)";
}

// Sanitization schema: allow standard markdown HTML + our callout elements.
// This prevents assistant replies containing <style>, <script>, or arbitrary
// HTML from mutating the DOM while still allowing the cc-callout divs we
// generate in preprocessCallouts().
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div", "span", "hr",
  ],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    hr: [...(defaultSchema.attributes?.hr ?? []), "className"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "class"],
  },
};

// Shared rehype plugin list (stable reference avoids re-creating on every render)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS: any[] = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeHighlight,
];
const REMARK_PLUGINS = [remarkGfm];

/** Context to pass sticky-scroll handler into streaming sub-components. */
const ScrollContext = createContext<{
  handleContentChanged: () => void;
}>({ handleContentChanged: () => {} });

// Stable empty arrays to avoid Zustand selector re-renders when data is undefined.
// Without these, `?? []` / `|| []` creates a new reference on every store update,
// causing Object.is to return false and triggering unnecessary component re-renders.
const EMPTY_COMPLETED_TURNS: CompletedTurn[] = [];
const EMPTY_ACTIVITIES: ToolActivity[] = [];

export function ChatPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const hydrateCompletedTurns = useAppStore((s) => s.hydrateCompletedTurns);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Prompt history: stores past user inputs per workspace.
  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  useAgentStream();

  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;
  const messages = selectedWorkspaceId
    ? chatMessages[selectedWorkspaceId] || []
    : [];
  // Subscribe only to boolean — avoids re-render on every streaming character
  const hasStreaming = useAppStore(
    (s) => !!(selectedWorkspaceId && s.streamingContent[selectedWorkspaceId])
  );
  const hasThinking = useAppStore(
    (s) => !!(selectedWorkspaceId && s.streamingThinking[selectedWorkspaceId])
  );
  const showThinkingBlocks = useAppStore(
    (s) => selectedWorkspaceId ? s.showThinkingBlocks[selectedWorkspaceId] === true : false
  );
  // Subscribe only to count — avoids re-render on tool activity content changes
  const activitiesCount = useAppStore(
    (s) => (selectedWorkspaceId ? (s.toolActivities[selectedWorkspaceId] || []).length : 0)
  );
  const completedTurnsCount = useAppStore(
    (s) => (selectedWorkspaceId ? (s.completedTurns[selectedWorkspaceId] || []).length : 0)
  );
  const permissionLevelMap = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const permissionLevel = selectedWorkspaceId
    ? permissionLevelMap[selectedWorkspaceId] ?? "full"
    : "full";
  const pendingQuestion = useAppStore(
    (s) => (selectedWorkspaceId ? s.agentQuestions[selectedWorkspaceId] ?? null : null)
  );
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const pendingPlan = useAppStore(
    (s) => (selectedWorkspaceId ? s.planApprovals[selectedWorkspaceId] ?? null : null)
  );
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const queuedMessage = useAppStore(
    (s) => (selectedWorkspaceId ? s.queuedMessages[selectedWorkspaceId] ?? null : null)
  );
  const setQueuedMessage = useAppStore((s) => s.setQueuedMessage);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const isRunning = ws?.agent_status === "Running";

  // Sticky scroll: auto-follow when at bottom, stop when user scrolls up.
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(messagesContainerRef);

  // Memoize context value to avoid re-rendering StreamingMessage on every parent render.
  const scrollContextValue = useMemo(
    () => ({ handleContentChanged }),
    [handleContentChanged],
  );

  // Spinner and elapsed timer for running agent.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning) {
      startTimeRef.current = null;
      return;
    }
    if (!startTimeRef.current) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      setSpinnerIdx(0);
    }
    const interval = setInterval(() => {
      setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length);
      if (startTimeRef.current) {
        const newElapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsed((prev) => (prev === newElapsed ? prev : newElapsed));
      }
    }, 80);
    return () => clearInterval(interval);
  }, [isRunning]);

  const formatElapsed = useCallback((secs: number) => {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  }, []);

  // Load persisted permission level when workspace changes.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    let cancelled = false;
    getAppSetting(`permission_level:${selectedWorkspaceId}`)
      .then((val) => {
        if (cancelled) return;
        if (val === "readonly" || val === "standard" || val === "full") {
          setPermissionLevel(selectedWorkspaceId, val);
        }
      })
      .catch((err) => {
        console.error("Failed to load permission level:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, setPermissionLevel]);

  // Load chat history when workspace changes, seed prompt history from it.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    let cancelled = false;
    setError(null);
    historyIndexRef.current = -1;
    draftRef.current = "";

    const currentWs = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId);
    const loadHistory = currentWs?.remote_connection_id
      ? sendRemoteCommand(currentWs.remote_connection_id, "load_chat_history", {
          workspace_id: selectedWorkspaceId,
        }).then((data) => (data as { messages?: ChatMessage[] })?.messages ?? data as ChatMessage[])
      : loadChatHistory(selectedWorkspaceId);

    const wsId = selectedWorkspaceId;
    const isLocal = !currentWs?.remote_connection_id;

    debugChat("ChatPanel", "load-history:start", {
      wsId,
      isLocal,
      agentStatus: currentWs?.agent_status ?? null,
    });

    loadHistory
      .then((msgs: ChatMessage[]) => {
        if (cancelled) return;
        // Filter out empty assistant messages (legacy data), but keep
        // those that carry thinking content.
        const filtered = msgs.filter(
          (m) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking
        );
        debugChat("ChatPanel", "load-history:success", {
          wsId,
          rawMessageCount: msgs.length,
          filteredMessageCount: filtered.length,
          messageIds: filtered.map((msg) => msg.id),
        });
        setChatMessages(wsId, filtered);
        historyRef.current[wsId] = filtered
          .filter((m) => m.role === "User")
          .map((m) => m.content);

        // Load persisted completed turns and reconstruct with correct positions.
        // Skip if the agent is currently running — the in-memory state from
        // finalizeTurn() is more current than the DB and must not be overwritten.
        if (isLocal) {
          const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId);
          const isRunning = ws?.agent_status === "Running";
          debugChat("ChatPanel", "load-completed-turns:gate", {
            wsId,
            isRunning,
            currentCompletedTurnIds: (useAppStore.getState().completedTurns[wsId] || []).map(
              (turn) => turn.id
            ),
          });
          if (!isRunning) {
            loadCompletedTurns(wsId)
              .then((turnData) => {
                if (cancelled) return;
                const turns = reconstructCompletedTurns(filtered, turnData);
                debugChat("ChatPanel", "load-completed-turns:success", {
                  wsId,
                  dbTurnIds: turnData.map((turn) => turn.checkpoint_id),
                  reconstructedTurnIds: turns.map((turn) => turn.id),
                });
                hydrateCompletedTurns(wsId, turns);
              })
              .catch((e) => console.error("Failed to load completed turns:", e));
          }
        }
      })
      .catch((e) => console.error("Failed to load chat history:", e));

    // Load checkpoints for rollback support.
    if (isLocal) {
      const setCheckpoints = useAppStore.getState().setCheckpoints;
      listCheckpoints(wsId)
        .then((cps) => {
          if (cancelled) return;
          setCheckpoints(wsId, cps);
        })
        .catch((e) => console.error("Failed to load checkpoints:", e));
    }

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, setChatMessages, hydrateCompletedTurns]);

  // Scroll to bottom unconditionally on workspace switch.
  useEffect(() => {
    if (selectedWorkspaceId) scrollToBottom();
  }, [selectedWorkspaceId, scrollToBottom]);

  // Auto-scroll when new content arrives — respects user intent via useStickyScroll.
  // Only scrolls if the user is already at/near the bottom.
  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const wsId = selectedWorkspaceId;
    if (!wsId) return;
    const prev = prevMsgCountRef.current[wsId] ?? 0;
    const cur = messages.length;
    prevMsgCountRef.current[wsId] = cur;
    // Only trigger on genuinely new messages (count increase), not DB rehydration.
    if (cur > prev) handleContentChanged();
  }, [messages.length, selectedWorkspaceId, handleContentChanged]);

  useEffect(() => {
    if (completedTurnsCount > 0 || activitiesCount > 0 || pendingQuestion || pendingPlan) {
      handleContentChanged();
    }
  }, [completedTurnsCount, activitiesCount, pendingQuestion, pendingPlan, handleContentChanged]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    debugChat("ChatPanel", "state", {
      wsId: selectedWorkspaceId,
      isRunning,
      messageCount: messages.length,
      activitiesCount,
      completedTurnsCount,
      hasStreaming,
    });
  }, [
    selectedWorkspaceId,
    isRunning,
    messages.length,
    activitiesCount,
    completedTurnsCount,
    hasStreaming,
  ]);

  // Auto-dispatch queued message when agent becomes idle.
  const handleSendRef = useRef<((content: string, mentionedFiles?: Set<string>) => void) | null>(null);
  useEffect(() => {
    if (isRunning || !selectedWorkspaceId || !queuedMessage) return;
    // Agent just finished — dispatch the queued message.
    const { content, mentionedFiles } = queuedMessage;
    clearQueuedMessage(selectedWorkspaceId);
    const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
    // Use a microtask to avoid calling handleSend during render.
    queueMicrotask(() => handleSendRef.current?.(content, filesSet));
  }, [isRunning, selectedWorkspaceId, queuedMessage, clearQueuedMessage]);

  if (!ws) return null;

  const handleSend = async (content: string, mentionedFiles?: Set<string>) => {
    const trimmed = content.trim();
    if (!trimmed || !selectedWorkspaceId) return;

    // Convert mentioned files set to array for the backend.
    const mentionedFilesArray = mentionedFiles?.size
      ? [...mentionedFiles]
      : undefined;

    // If the agent is running, queue the message instead of interrupting.
    // The user can press Escape to stop the agent if they want to interrupt.
    // Queued messages are auto-sent when the current turn finishes.
    if (isRunning) {
      setQueuedMessage(selectedWorkspaceId, trimmed, mentionedFilesArray);
      return;
    }

    // Clear any pending agent question or plan approval — the user is sending
    // a new message (answer from a card or manual override).
    if (selectedWorkspaceId) {
      clearAgentQuestion(selectedWorkspaceId);
      clearPlanApproval(selectedWorkspaceId);
    }

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[selectedWorkspaceId] ??= []);
    history.push(trimmed);
    historyIndexRef.current = -1;
    draftRef.current = "";
    addChatMessage(selectedWorkspaceId, {
      id: crypto.randomUUID(),
      workspace_id: selectedWorkspaceId,
      role: "User",
      content: trimmed,
      cost_usd: null,
      duration_ms: null,
      created_at: new Date().toISOString(),
      thinking: null,
    });
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });

    try {
      if (ws?.remote_connection_id) {
        // Route to remote server via WebSocket.
        const state = useAppStore.getState();
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          workspace_id: selectedWorkspaceId,
          content: trimmed,
          mentioned_files: mentionedFilesArray,
          permission_level: permissionLevel,
          model: state.selectedModel[selectedWorkspaceId] || null,
          fast_mode: state.fastMode[selectedWorkspaceId] || false,
          thinking_enabled: state.thinkingEnabled[selectedWorkspaceId] || false,
          plan_mode: state.planMode[selectedWorkspaceId] || false,
          effort: state.effortLevel[selectedWorkspaceId] || null,
          chrome_enabled: state.chromeEnabled[selectedWorkspaceId] || false,
        });
      } else {
        const state = useAppStore.getState();
        const model = state.selectedModel[selectedWorkspaceId] || undefined;
        const fastMode = state.fastMode[selectedWorkspaceId] || false;
        const thinkingEnabled = state.thinkingEnabled[selectedWorkspaceId] || false;
        const planMode = state.planMode[selectedWorkspaceId] || false;
        const effort = state.effortLevel[selectedWorkspaceId] || undefined;
        const chromeEnabled = state.chromeEnabled[selectedWorkspaceId] || false;
        await sendChatMessage(
          selectedWorkspaceId,
          trimmed,
          mentionedFilesArray,
          permissionLevel,
          model,
          fastMode || undefined,
          thinkingEnabled || undefined,
          planMode || undefined,
          effort,
          chromeEnabled || undefined,
        );
      }
    } catch (e) {
      const errMsg = String(e);
      console.error("sendChatMessage failed:", errMsg);
      setError(errMsg);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Idle" });
    }
  };

  handleSendRef.current = handleSend;

  const handleStop = async () => {
    if (!selectedWorkspaceId) return;
    // Clear queued message — stopping means the user wants to take control.
    clearQueuedMessage(selectedWorkspaceId);
    try {
      if (ws?.remote_connection_id) {
        await sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
          workspace_id: selectedWorkspaceId,
        });
      } else {
        await stopAgent(selectedWorkspaceId);
      }
      updateWorkspace(selectedWorkspaceId, { agent_status: "Stopped" });
    } catch (e) {
      console.error("stopAgent failed:", e);
    }
  };

  const agentStatusLabel =
    typeof ws.agent_status === "string"
      ? ws.agent_status
      : `Error: ${ws.agent_status.Error}`;

  const agentStatusColor =
    ws.agent_status === "Running"
      ? "var(--status-running)"
      : ws.agent_status === "Stopped" ||
          typeof ws.agent_status !== "string"
        ? "var(--status-stopped)"
        : "var(--status-idle)";

  return (
    <div className={styles.panel}>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft}>
          <button
            className={styles.dashboardBtn}
            onClick={() => !isRunning && selectWorkspace(null)}
            title={isRunning ? "Stop the agent before navigating away" : "Back to dashboard"}
            aria-label="Back to dashboard"
            type="button"
            disabled={isRunning}
          >
            <LayoutDashboard size={14} />
          </button>
          {repo ? (
            <span className={styles.branchInfo}>
              <span className={styles.repoName}>{repo.name}</span>
              <span className={styles.branchSep}>/</span>
              <GitBranch size={12} className={styles.branchIcon} />
              <span className={styles.branchName}>{ws.branch_name}</span>
              {defaultBranch && (
                <>
                  <span className={styles.branchArrow}>{'>'}</span>
                  <span className={styles.baseBranch}>{defaultBranch.replace(/^origin\//, '')}</span>
                </>
              )}
            </span>
          ) : (
            <span className={styles.repoName}>{ws.name}</span>
          )}
        </div>
        <div className={styles.headerRight}>
          <WorkspaceActions
            worktreePath={ws.worktree_path}
            disabled={isRunning}
          />
          <HeaderMenu
            label="Permissions"
            items={[
              { value: "readonly", label: "Read-only" },
              { value: "standard", label: "Standard" },
              { value: "full", label: "Full access" },
            ]}
            value={permissionLevel}
            disabled={isRunning}
            title="Tool permission level for this workspace"
            onSelect={async (val) => {
              if (!selectedWorkspaceId) return;
              const previous = permissionLevel;
              const level = val as "readonly" | "standard" | "full";
              setPermissionLevel(selectedWorkspaceId, level);
              try {
                await setAppSetting(
                  `permission_level:${selectedWorkspaceId}`,
                  level
                );
              } catch (err) {
                console.error("Failed to persist permission level:", err);
                setPermissionLevel(selectedWorkspaceId, previous);
              }
            }}
          />
          <span
            className={styles.statusBadge}
            style={{ color: agentStatusColor }}
          >
            {agentStatusLabel}
          </span>
          {isRunning ? (
            <button className={styles.stopBtn} onClick={handleStop}>
              Stop
            </button>
          ) : null}
          <PanelToggles />
        </div>
      </div>

      <ScrollContext.Provider value={scrollContextValue}>
        <div className={styles.messages} ref={messagesContainerRef}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          {messages.length === 0 && !hasStreaming ? (
            <div className={styles.empty}>
              Send a message to start a conversation
            </div>
          ) : (
            <>
              {selectedWorkspaceId && (
                <MessagesWithTurns
                  messages={messages}
                  workspaceId={selectedWorkspaceId}
                  isRunning={isRunning}
                />
              )}

              {selectedWorkspaceId && hasThinking && showThinkingBlocks && (
                <StreamingThinkingBlock workspaceId={selectedWorkspaceId} isStreaming={isRunning ?? false} />
              )}

              {selectedWorkspaceId && hasStreaming && (
                <StreamingMessage workspaceId={selectedWorkspaceId} />
              )}

              {selectedWorkspaceId && activitiesCount > 0 && (
                <ToolActivitiesSection
                  workspaceId={selectedWorkspaceId}
                  isRunning={isRunning ?? false}
                />
              )}

              {selectedWorkspaceId && (
                <CurrentTurnTaskProgress workspaceId={selectedWorkspaceId} />
              )}

              {pendingQuestion && (
                <AgentQuestionCard
                  question={pendingQuestion}
                  onRespond={(response) => {
                    if (selectedWorkspaceId) clearAgentQuestion(selectedWorkspaceId);
                    handleSend(response);
                  }}
                />
              )}

              {pendingPlan && (
                <PlanApprovalCard
                  approval={pendingPlan}
                  remoteConnectionId={ws?.remote_connection_id ?? undefined}
                  onRespond={(response) => {
                    if (selectedWorkspaceId) clearPlanApproval(selectedWorkspaceId);
                    handleSend(response);
                  }}
                />
              )}

              {isRunning && !pendingQuestion && !pendingPlan && (
                <div
                  ref={processingRef}
                  className={styles.processing}
                  role="status"
                  aria-label={`Processing, ${formatElapsed(elapsed)} elapsed`}
                >
                  <span className={styles.spinner} aria-hidden="true">{SPINNER_FRAMES[spinnerIdx]}</span>
                  <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                </div>
              )}

              {queuedMessage && selectedWorkspaceId && (
                <div className={styles.queuedMessage}>
                  <span className={styles.queuedLabel}>Queued</span>
                  <span className={styles.queuedContent}>{queuedMessage.content}</span>
                  <button
                    className={styles.queuedCancel}
                    onClick={() => clearQueuedMessage(selectedWorkspaceId)}
                    title="Cancel queued message"
                  >
                    ×
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollContext.Provider>

      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />

      <ChatInputArea
        onSend={handleSend}
        isRunning={isRunning}
        selectedWorkspaceId={selectedWorkspaceId!}
        projectPath={repo?.path}
        historyRef={historyRef}
        historyIndexRef={historyIndexRef}
        draftRef={draftRef}
      />
    </div>
  );
}

/**
 * Isolated thinking block — subscribes to streamingThinking to avoid
 * re-rendering ChatPanel on every thinking delta.
 */
const StreamingThinkingBlock = memo(function StreamingThinkingBlock({
  workspaceId,
  isStreaming,
}: {
  workspaceId: string;
  isStreaming: boolean;
}) {
  const thinking = useAppStore(
    (s) => s.streamingThinking[workspaceId] || ""
  );
  if (!thinking) return null;
  return <ThinkingBlock content={thinking} isStreaming={isStreaming} />;
});

/**
 * Isolated streaming message component — subscribes to streaming text directly
 * and throttles Markdown re-parsing to ~16fps via requestAnimationFrame.
 * This prevents the entire ChatPanel from re-rendering on every character delta.
 */
const StreamingMessage = memo(function StreamingMessage({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const streaming = useAppStore(
    (s) => s.streamingContent[workspaceId] || ""
  );
  const { handleContentChanged } = useContext(ScrollContext);

  // Throttle Markdown rendering: store latest text in ref, update at ~16fps
  const latestRef = useRef(streaming);
  latestRef.current = streaming;
  const [displayed, setDisplayed] = useState(streaming);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let lastTime = 0;
    const THROTTLE_MS = 60; // ~16fps
    const tick = (time: number) => {
      if (time - lastTime >= THROTTLE_MS) {
        lastTime = time;
        setDisplayed(latestRef.current);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Auto-scroll when streaming content grows — respects user scroll intent.
  useEffect(() => {
    handleContentChanged();
  }, [displayed, handleContentChanged]);

  if (!displayed) return null;

  return (
    <div className={`${styles.message} ${styles.role_Assistant}`}>
      <div className={styles.content}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
        >
          {preprocessContent(displayed)}
        </Markdown>
        <span className={styles.cursor} />
      </div>
    </div>
  );
});

/**
 * Render a single completed turn summary (collapsible tool call list).
 */
function TurnSummary({
  turn,
  collapsed,
  onToggle,
  taskProgress,
}: {
  turn: CompletedTurn;
  collapsed: boolean;
  onToggle: () => void;
  taskProgress?: TaskTrackerResult;
}) {
  return (
    <div className={styles.turnSummaryWrapper}>
      <div
        className={styles.turnSummary}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className={styles.turnHeader}>
          <span className={styles.toolChevron}>
            {collapsed ? "›" : "⌄"}
          </span>
          <span className={styles.turnLabel}>
            {turn.activities.length} tool call
            {turn.activities.length !== 1 ? "s" : ""}
            {turn.messageCount > 0 &&
              `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
          </span>
        </div>
        {!collapsed && (
          <div className={styles.turnActivities}>
            {turn.activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>
                    {act.toolName}
                  </span>
                  {(act.summary || act.inputJson) && (
                    <span className={styles.toolSummary}>
                      {act.summary || extractToolSummary(act.toolName, act.inputJson)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {taskProgress && taskProgress.totalCount > 0 && (
        <TaskProgressBar
          completedCount={taskProgress.completedCount}
          totalCount={taskProgress.totalCount}
        />
      )}
    </div>
  );
}

/** Inline progress bar rendered beneath a turn summary when tasks are present. */
function TaskProgressBar({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const allDone = completedCount === totalCount;

  return (
    <div className={styles.taskProgressBar}>
      <div className={styles.taskProgressTrack}>
        <div
          className={`${styles.taskProgressFill} ${allDone ? styles.taskProgressDone : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={styles.taskProgressLabel}>
        {completedCount}/{totalCount} tasks
      </span>
    </div>
  );
}

/**
 * Renders all messages interleaved with completed turn summaries at the correct
 * chronological position. Uses a single store subscription + useMemo to avoid
 * per-message selectors and redundant re-renders during streaming.
 */
const EMPTY_CHECKPOINTS: import("../../types/checkpoint").ConversationCheckpoint[] = [];

const MessagesWithTurns = memo(function MessagesWithTurns({
  messages,
  workspaceId,
  isRunning,
}: {
  messages: ChatMessage[];
  workspaceId: string;
  isRunning: boolean;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[workspaceId] ?? EMPTY_COMPLETED_TURNS
  );
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const checkpoints = useAppStore(
    (s) => s.checkpoints[workspaceId] ?? EMPTY_CHECKPOINTS
  );
  const openModal = useAppStore((s) => s.openModal);
  const showThinkingBlocks = useAppStore(
    (s) => s.showThinkingBlocks[workspaceId] === true
  );

  // Build an index: afterMessageIndex → array of (turn, globalIndex) pairs.
  // Only recomputed when completedTurns changes, not on every streaming update.
  const turnsByPosition = useMemo(() => {
    const map: Record<number, Array<{ turn: CompletedTurn; globalIdx: number }>> = {};
    completedTurns.forEach((turn, globalIdx) => {
      const key = turn.afterMessageIndex;
      (map[key] ??= []).push({ turn, globalIdx });
    });
    return map;
  }, [completedTurns]);

  // Map user message index → checkpoint for the preceding turn.
  // Checks the message immediately before this user message (assistant or
  // user for tool-only turns) for a matching checkpoint. Index 0 always
  // maps to null (clear-all) when any checkpoints exist.
  const rollbackCheckpointByIdx = useMemo(
    () => buildRollbackMap(messages, checkpoints),
    [messages, checkpoints],
  );

  // Compute cumulative task progress at each turn index in a single O(n) pass.
  // Carries taskMap/todoMap forward across iterations instead of re-slicing.
  const taskProgressByTurn = useMemo(() => {
    const map = new Map<number, TaskTrackerResult>();
    const taskMap = new Map<string, TrackedTask>();
    const todoMap = new Map<string, TrackedTask>();
    const nextSyntheticId = { value: 1 };
    let anyTasksSoFar = false;

    for (let i = 0; i < completedTurns.length; i++) {
      processActivities(completedTurns[i].activities, taskMap, todoMap, nextSyntheticId);
      if (turnHasTaskActivity(completedTurns[i])) {
        anyTasksSoFar = true;
      }
      if (anyTasksSoFar) {
        const tasks = [...taskMap.values(), ...todoMap.values()];
        const completedCount = tasks.filter((t) => t.status === "completed").length;
        map.set(i, { tasks, completedCount, totalCount: tasks.length });
      }
    }
    return map;
  }, [completedTurns]);

  useEffect(() => {
    debugChat("MessagesWithTurns", "layout", {
      workspaceId,
      messageIds: messages.map((msg) => msg.id),
      turnLayout: completedTurns.map((turn) => ({
        id: turn.id,
        afterMessageIndex: turn.afterMessageIndex,
        postLastMessage: turn.afterMessageIndex >= messages.length,
        toolCount: turn.activities.length,
      })),
    });
  }, [workspaceId, messages, completedTurns]);

  const renderTurns = (position: number) => {
    const entries = turnsByPosition[position];
    if (!entries) return null;
    return entries.map(({ turn, globalIdx }) => (
      <TurnSummary
        key={turn.id}
        turn={turn}
        collapsed={turn.collapsed}
        onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
        taskProgress={taskProgressByTurn.get(globalIdx)}
      />
    ));
  };

  return (
    <>
      {messages.map((msg, idx) => (
        <React.Fragment key={msg.id}>
          {renderTurns(idx)}
          <div className={`${styles.message} ${styles[`role_${msg.role}`]}`}>
            {msg.role === "User" && (
              <div className={styles.roleLabel}>You</div>
            )}
            {msg.role === "User" &&
              !isRunning &&
              rollbackCheckpointByIdx.has(idx) && (
                <button
                  className={styles.rollbackBtn}
                  title="Roll back to before this message"
                  onClick={(e) => {
                    e.stopPropagation();
                    const cp = rollbackCheckpointByIdx.get(idx);
                    openModal("rollback", {
                      workspaceId,
                      checkpointId: cp ? cp.id : null,
                      messagePreview: msg.content.slice(0, 100),
                      messageContent: msg.content,
                      hasFileChanges: cp
                        ? checkpointHasFileChanges(cp, checkpoints)
                        : clearAllHasFileChanges(checkpoints),
                    });
                  }}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            {msg.role === "Assistant" && msg.thinking && showThinkingBlocks && (
              <ThinkingBlock content={msg.thinking} isStreaming={false} />
            )}
            <div className={styles.content}>
              {msg.role === "Assistant" ? (
                <Markdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                >
                  {preprocessContent(msg.content)}
                </Markdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        </React.Fragment>
      ))}
      {/* Turns that finalized after or at the last message index */}
      {completedTurns
        .map((turn, globalIdx) => ({ turn, globalIdx }))
        .filter(({ turn }) => turn.afterMessageIndex >= messages.length)
        .map(({ turn, globalIdx }) => (
          <TurnSummary
            key={turn.id}
            turn={turn}
            collapsed={turn.collapsed}
            onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
            taskProgress={taskProgressByTurn.get(globalIdx)}
          />
        ))}
    </>
  );
});

/**
 * Current tool activities section — subscribes to toolActivities for this workspace.
 * Isolated so streaming text changes don't cause re-renders here.
 */
const ToolActivitiesSection = memo(function ToolActivitiesSection({
  workspaceId,
  isRunning,
}: {
  workspaceId: string;
  isRunning: boolean;
}) {
  const activities = useAppStore(
    (s) => s.toolActivities[workspaceId] ?? EMPTY_ACTIVITIES
  );
  const [collapsed, setCollapsed] = useState(true);

  // Auto-collapse when a new turn starts (activities goes from 0 to non-zero)
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (isRunning && activities.length > 0 && prevLengthRef.current === 0) {
      setCollapsed(true);
    }
    prevLengthRef.current = activities.length;
  }, [isRunning, activities.length]);

  if (activities.length === 0) return null;

  return (
    <div className={styles.toolActivities} aria-live="polite" aria-atomic="true">
      <div className={styles.turnSummary}>
        <div
          className={styles.turnHeader}
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed(!collapsed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed(!collapsed);
            }
          }}
        >
          <span className={styles.toolChevron}>
            {collapsed ? "›" : "⌄"}
          </span>
          <span className={styles.turnLabel}>
            {activities.length} tool call{activities.length !== 1 ? "s" : ""}
            {isRunning && <span style={{ color: "var(--accent-dim)" }}> in progress</span>}
          </span>
        </div>
        {!collapsed && (
          <div className={styles.turnActivities}>
            {activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>{act.toolName}</span>
                  {act.summary && (
                    <span className={styles.toolSummary}>
                      {act.summary}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Shows a progress bar for the current in-progress turn, only when
 * task-related tools are among the current activities. Disappears when
 * the turn finalises (tasks move into CompletedTurn rendering).
 */
const CurrentTurnTaskProgress = memo(function CurrentTurnTaskProgress({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[workspaceId] ?? EMPTY_COMPLETED_TURNS
  );
  const toolActivities = useAppStore(
    (s) => s.toolActivities[workspaceId] ?? EMPTY_ACTIVITIES
  );

  const result = useMemo(
    () => deriveTasks(completedTurns, toolActivities),
    [completedTurns, toolActivities]
  );

  // Only render when the current turn has task tools
  if (!hasTaskActivity(toolActivities) || result.totalCount === 0) return null;

  return (
    <TaskProgressBar completedCount={result.completedCount} totalCount={result.totalCount} />
  );
});

/** Extract the @-query based on cursor position in the textarea. */
function extractMentionQuery(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos);
  const atIndex = before.lastIndexOf("@");
  if (atIndex === -1) return null;
  // The @ must be at start of input or preceded by whitespace.
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;
  const query = before.slice(atIndex + 1);
  // If query contains whitespace, the mention is "closed".
  if (/\s/.test(query)) return null;
  return query;
}

// Separate component for input area to prevent full ChatPanel re-renders on every keystroke
function ChatInputArea({
  onSend,
  isRunning,
  selectedWorkspaceId,
  projectPath,
  historyRef,
  historyIndexRef,
  draftRef,
}: {
  onSend: (content: string, mentionedFiles?: Set<string>) => Promise<void>;
  isRunning: boolean;
  selectedWorkspaceId: string;
  projectPath: string | undefined;
  historyRef: React.MutableRefObject<Record<string, string[]>>;
  historyIndexRef: React.MutableRefObject<number>;
  draftRef: React.MutableRefObject<string>;
}) {
  const [chatInput, setChatInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [slashPickerIndex, setSlashPickerIndex] = useState(0);
  const [slashPickerDismissed, setSlashPickerDismissed] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [filePickerDismissed, setFilePickerDismissed] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filesCache = useRef<Record<string, FileEntry[]>>({});
  const mentionedFilesRef = useRef<Set<string>>(new Set());

  // Per-workspace draft storage: save input when switching away,
  // restore when switching back.
  const draftsRef = useRef<Record<string, string>>({});
  const prevWorkspaceRef = useRef(selectedWorkspaceId);
  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev !== selectedWorkspaceId) {
      // Save draft for the workspace we're leaving.
      draftsRef.current[prev] = chatInput;
      // Restore draft for the workspace we're entering.
      setChatInput(draftsRef.current[selectedWorkspaceId] ?? "");
      prevWorkspaceRef.current = selectedWorkspaceId;
      // Reset file picker state for new workspace.
      setFilesLoaded(false);
      setWorkspaceFiles([]);
      mentionedFilesRef.current = new Set();
    }
  }, [selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the textarea when switching or creating workspaces.
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [selectedWorkspaceId]);

  // Consume prefill text (e.g. from rollback) and focus the textarea.
  const chatInputPrefill = useAppStore((s) => s.chatInputPrefill);
  const setChatInputPrefill = useAppStore((s) => s.setChatInputPrefill);
  useEffect(() => {
    if (chatInputPrefill) {
      setChatInput(chatInputPrefill);
      setChatInputPrefill(null);
      // Focus and move cursor to end after React re-renders.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    }
  }, [chatInputPrefill, setChatInputPrefill]);

  const refreshSlashCommands = useCallback(() => {
    listSlashCommands(projectPath, selectedWorkspaceId)
      .then(setSlashCommands)
      .catch((e) => console.error("Failed to load slash commands:", e));
  }, [projectPath, selectedWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    listSlashCommands(projectPath, selectedWorkspaceId)
      .then((cmds) => {
        if (!cancelled) setSlashCommands(cmds);
      })
      .catch((e) => console.error("Failed to load slash commands:", e));
    return () => {
      cancelled = true;
    };
  }, [projectPath, selectedWorkspaceId]);

  const slashQuery = chatInput.startsWith("/") ? chatInput.slice(1) : null;
  const slashResults = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(slashCommands, slashQuery)),
    [slashCommands, slashQuery],
  );
  const showSlashPicker = slashQuery !== null && slashResults.length > 0 && !slashPickerDismissed;

  useEffect(() => {
    setSlashPickerIndex(0);
    setSlashPickerDismissed(false);
  }, [slashQuery]);

  // --- File mention picker ---

  const loadFiles = useCallback(async () => {
    if (filesCache.current[selectedWorkspaceId]) {
      setWorkspaceFiles(filesCache.current[selectedWorkspaceId]);
      setFilesLoaded(true);
      return;
    }
    try {
      const files = await listWorkspaceFiles(selectedWorkspaceId);
      filesCache.current[selectedWorkspaceId] = files;
      setWorkspaceFiles(files);
      setFilesLoaded(true);
    } catch (e) {
      console.error("Failed to load workspace files:", e);
    }
  }, [selectedWorkspaceId]);

  const mentionQuery = extractMentionQuery(chatInput, cursorPos);
  const mentionResults = useMemo(
    () => (mentionQuery === null ? [] : matchFiles(workspaceFiles, mentionQuery)),
    [workspaceFiles, mentionQuery],
  );
  const showFilePicker =
    mentionQuery !== null && mentionResults.length > 0 && !filePickerDismissed && filesLoaded;

  // Lazy-load file list on first @ trigger.
  useEffect(() => {
    if (mentionQuery !== null && !filesLoaded) {
      loadFiles();
    }
  }, [mentionQuery, filesLoaded, loadFiles]);

  // Reset picker index when query changes.
  useEffect(() => {
    setFilePickerIndex(0);
    setFilePickerDismissed(false);
  }, [mentionQuery]);

  const insertFileMention = useCallback(
    (file: FileEntry) => {
      const before = chatInput.slice(0, cursorPos);
      const atIndex = before.lastIndexOf("@");
      const after = chatInput.slice(cursorPos);
      const mention = `@${file.path}`;
      // Directories: no trailing space so the user can keep narrowing.
      // Files: add a trailing space to close the mention.
      const suffix = file.is_directory ? "" : " ";
      const newText = before.slice(0, atIndex) + mention + suffix + after;
      setChatInput(newText);
      const newCursor = atIndex + mention.length + suffix.length;
      setCursorPos(newCursor);
      if (!file.is_directory) {
        mentionedFilesRef.current.add(file.path);
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newCursor;
          ta.focus();
        }
      });
    },
    [chatInput, cursorPos],
  );

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto";
    // Set height to scrollHeight; CSS max-height will cap it
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [chatInput]);

  const handleSend = () => {
    // Only include files whose @path tokens are still in the text, so that
    // removed references don't get expanded.
    const activeFiles = new Set<string>();
    for (const path of mentionedFilesRef.current) {
      if (chatInput.includes(`@${path}`)) {
        activeFiles.add(path);
      }
    }
    const files = activeFiles.size > 0 ? activeFiles : undefined;
    onSend(chatInput, files);
    setChatInput("");
    mentionedFilesRef.current = new Set();
  };

  const planMode = useAppStore(
    (s) => s.planMode[selectedWorkspaceId] ?? false,
  );
  const setPlanMode = useAppStore((s) => s.setPlanMode);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Tab: toggle plan mode
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setPlanMode(selectedWorkspaceId, !planMode);
      return;
    }

    // File mention picker navigation (takes priority over slash picker)
    if (showFilePicker) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFilePickerIndex((i) => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFilePickerIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const result = mentionResults[filePickerIndex];
        if (result) insertFileMention(result.file);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const result = mentionResults[filePickerIndex];
        if (result) insertFileMention(result.file);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFilePickerDismissed(true);
        return;
      }
    }

    // Slash command picker navigation
    if (showSlashPicker) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashPickerIndex((i) => Math.min(i + 1, slashResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashPickerIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashResults[slashPickerIndex];
        if (cmd) {
          onSend("/" + cmd.name);
          setChatInput("");
          recordSlashCommandUsage(selectedWorkspaceId, cmd.name)
            .then(refreshSlashCommands)
            .catch((e) => console.error("Failed to record slash command usage:", e));
        }
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashResults[slashPickerIndex];
        if (cmd) {
          setChatInput("/" + cmd.name + " ");
          setSlashPickerDismissed(true);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashPickerDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // History navigation with arrow keys
    const history = historyRef.current[selectedWorkspaceId] ?? [];
    if (history.length === 0) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIndexRef.current === -1) {
        draftRef.current = chatInput;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      setChatInput(history[historyIndexRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndexRef.current === -1) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        setChatInput(history[historyIndexRef.current]);
      } else {
        historyIndexRef.current = -1;
        setChatInput(draftRef.current);
      }
    }
  };

  return (
    <div className={styles.inputArea}>
      {showFilePicker && (
        <FileMentionPicker
          results={mentionResults}
          selectedIndex={filePickerIndex}
          onSelect={insertFileMention}
          onHover={setFilePickerIndex}
        />
      )}
      {showSlashPicker && (
        <SlashCommandPicker
          commands={slashResults}
          selectedIndex={slashPickerIndex}
          onSelect={(cmd) => {
            onSend("/" + cmd.name);
            setChatInput("");
            recordSlashCommandUsage(selectedWorkspaceId, cmd.name)
            .then(refreshSlashCommands)
            .catch((e) => console.error("Failed to record slash command usage:", e));
          }}
          onHover={setSlashPickerIndex}
        />
      )}
      <textarea
        ref={textareaRef}
        className={`${styles.input}${planMode ? ` ${styles.inputPlanMode}` : ""}`}
        value={chatInput}
        onChange={(e) => {
          setChatInput(e.target.value);
          setCursorPos(e.target.selectionStart ?? 0);
        }}
        onSelect={(e) => {
          setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={isRunning ? "Type to queue a message..." : "Send a message..."}
      />
      <div className={styles.inputControls}>
        <ChatToolbar
          workspaceId={selectedWorkspaceId}
          disabled={isRunning}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={!chatInput.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
