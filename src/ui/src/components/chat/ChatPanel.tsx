import React, { memo, useEffect, useRef, useState, useMemo, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { AnsiUp } from "ansi_up";
import { GitBranch, LayoutDashboard } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity, CompletedTurn } from "../../stores/useAppStore";
import {
  loadChatHistory,
  listSlashCommands,
  recordSlashCommandUsage,
  sendChatMessage,
  sendRemoteCommand,
  stopAgent,
  getAppSetting,
  setAppSetting,
} from "../../services/tauri";
import type { SlashCommand } from "../../services/tauri";
import type { ChatMessage } from "../../types/chat";
import { useAgentStream } from "../../hooks/useAgentStream";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { ChatToolbar } from "./ChatToolbar";
import { WorkspaceActions } from "./WorkspaceActions";
import { HeaderMenu } from "./HeaderMenu";
import { SlashCommandPicker, filterSlashCommands } from "./SlashCommandPicker";
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
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
  // Subscribe only to count — avoids re-render on tool activity content changes
  const activitiesCount = useAppStore(
    (s) => (selectedWorkspaceId ? (s.toolActivities[selectedWorkspaceId] || []).length : 0)
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
  const isRunning = ws?.agent_status === "Running";

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
    setError(null);
    historyIndexRef.current = -1;
    draftRef.current = "";

    const currentWs = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId);
    const loadHistory = currentWs?.remote_connection_id
      ? sendRemoteCommand(currentWs.remote_connection_id, "load_chat_history", {
          workspace_id: selectedWorkspaceId,
        }).then((data) => (data as { messages?: ChatMessage[] })?.messages ?? data as ChatMessage[])
      : loadChatHistory(selectedWorkspaceId);

    loadHistory
      .then((msgs: ChatMessage[]) => {
        // Filter out empty assistant messages (legacy data).
        const filtered = msgs.filter(
          (m) => m.role !== "Assistant" || m.content.trim() !== ""
        );
        setChatMessages(selectedWorkspaceId, filtered);
        historyRef.current[selectedWorkspaceId] = filtered
          .filter((m) => m.role === "User")
          .map((m) => m.content);
      })
      .catch((e) => console.error("Failed to load chat history:", e));
  }, [selectedWorkspaceId, setChatMessages]);

  // Auto-scroll to bottom (on new messages or workspace switch — streaming handles its own scroll)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selectedWorkspaceId]);

  // Auto-scroll processing indicator into view when tool activities change
  useEffect(() => {
    if (isRunning && !pendingQuestion && activitiesCount > 0) {
      processingRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isRunning, pendingQuestion, activitiesCount]);

  if (!ws) return null;

  const handleSend = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !selectedWorkspaceId) return;

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
    });
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });

    try {
      if (ws?.remote_connection_id) {
        // Route to remote server via WebSocket.
        const state = useAppStore.getState();
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          workspace_id: selectedWorkspaceId,
          content: trimmed,
          permission_level: permissionLevel,
          model: state.selectedModel[selectedWorkspaceId] || null,
          fast_mode: state.fastMode[selectedWorkspaceId] || false,
          thinking_enabled: state.thinkingEnabled[selectedWorkspaceId] || false,
          plan_mode: state.planMode[selectedWorkspaceId] || false,
        });
      } else {
        const state = useAppStore.getState();
        const model = state.selectedModel[selectedWorkspaceId] || undefined;
        const fastMode = state.fastMode[selectedWorkspaceId] || false;
        const thinkingEnabled = state.thinkingEnabled[selectedWorkspaceId] || false;
        const planMode = state.planMode[selectedWorkspaceId] || false;
        await sendChatMessage(
          selectedWorkspaceId,
          trimmed,
          permissionLevel,
          model,
          fastMode || undefined,
          thinkingEnabled || undefined,
          planMode || undefined,
        );
      }
    } catch (e) {
      const errMsg = String(e);
      console.error("sendChatMessage failed:", errMsg);
      setError(errMsg);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Idle" });
    }
  };

  const handleStop = async () => {
    if (!selectedWorkspaceId) return;
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
      <div className={styles.header}>
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
                  <span className={styles.baseBranch}>{defaultBranch}</span>
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
        </div>
      </div>

      <div className={styles.messages}>
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
              />
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
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

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
 * Isolated streaming message component — subscribes to streaming text directly
 * and throttles Markdown re-parsing to ~10fps via requestAnimationFrame.
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

  // Throttle Markdown rendering: store latest text in ref, update at ~10fps
  const latestRef = useRef(streaming);
  latestRef.current = streaming;
  const [displayed, setDisplayed] = useState(streaming);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let lastTime = 0;
    const THROTTLE_MS = 100; // ~10fps
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

  // Auto-scroll when streaming content grows
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    elRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayed]);

  if (!displayed) return null;

  return (
    <div ref={elRef} className={`${styles.message} ${styles.role_Assistant}`}>
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
}: {
  turn: CompletedTurn;
  turnIndex: number;
  workspaceId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
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
                {act.summary && (
                  <span className={styles.toolSummary}>{act.summary}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders all messages interleaved with completed turn summaries at the correct
 * chronological position. Uses a single store subscription + useMemo to avoid
 * per-message selectors and redundant re-renders during streaming.
 */
const MessagesWithTurns = memo(function MessagesWithTurns({
  messages,
  workspaceId,
}: {
  messages: ChatMessage[];
  workspaceId: string;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[workspaceId] ?? EMPTY_COMPLETED_TURNS
  );
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);

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

  const renderTurns = (position: number) => {
    const entries = turnsByPosition[position];
    if (!entries) return null;
    return entries.map(({ turn, globalIdx }) => (
      <TurnSummary
        key={turn.id}
        turn={turn}
        turnIndex={globalIdx}
        workspaceId={workspaceId}
        collapsed={turn.collapsed}
        onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
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
            turnIndex={globalIdx}
            workspaceId={workspaceId}
            collapsed={turn.collapsed}
            onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
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
                  <span className={styles.toolName}>{act.toolName}</span>
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
  onSend: (content: string) => Promise<void>;
  isRunning: boolean;
  selectedWorkspaceId: string;
  projectPath: string | undefined;
  historyRef: React.MutableRefObject<Record<string, string[]>>;
  historyIndexRef: React.MutableRefObject<number>;
  draftRef: React.MutableRefObject<string>;
}) {
  const [chatInput, setChatInput] = useState("");
  const [slashPickerIndex, setSlashPickerIndex] = useState(0);
  const [slashPickerDismissed, setSlashPickerDismissed] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    onSend(chatInput);
    setChatInput("");
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
        className={styles.input}
        value={chatInput}
        onChange={(e) => setChatInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        disabled={isRunning}
      />
      <div className={styles.inputControls}>
        <ChatToolbar
          workspaceId={selectedWorkspaceId}
          disabled={isRunning}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={!chatInput.trim() || isRunning}
        >
          Send
        </button>
      </div>
    </div>
  );
}
