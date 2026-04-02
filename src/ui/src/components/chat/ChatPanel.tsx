import { useEffect, useRef, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GitBranch, LayoutDashboard } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadChatHistory,
  sendChatMessage,
  stopAgent,
  getAppSetting,
  setAppSetting,
} from "../../services/tauri";
import { useAgentStream } from "../../hooks/useAgentStream";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { WorkspaceActions } from "./WorkspaceActions";
import styles from "./ChatPanel.module.css";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function ChatPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const chatInput = useAppStore((s) => s.chatInput);
  const setChatInput = useAppStore((s) => s.setChatInput);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const streamingContent = useAppStore((s) => s.streamingContent);
  const toolActivities = useAppStore((s) => s.toolActivities);
  const toggleToolActivityCollapsed = useAppStore(
    (s) => s.toggleToolActivityCollapsed
  );
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
  const streaming = selectedWorkspaceId
    ? streamingContent[selectedWorkspaceId] || ""
    : "";
  const completedTurnsMap = useAppStore((s) => s.completedTurns);
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const completedTurns = selectedWorkspaceId
    ? completedTurnsMap[selectedWorkspaceId] ?? []
    : [];
  const activities = selectedWorkspaceId
    ? toolActivities[selectedWorkspaceId] || []
    : [];
  const permissionLevelMap = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const permissionLevel = selectedWorkspaceId
    ? permissionLevelMap[selectedWorkspaceId] ?? "full"
    : "full";
  const agentQuestion = useAppStore((s) => s.agentQuestion);
  const setAgentQuestion = useAppStore((s) => s.setAgentQuestion);
  const isRunning = ws?.agent_status === "Running";
  const pendingQuestion =
    agentQuestion?.workspaceId === selectedWorkspaceId ? agentQuestion : null;

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
    loadChatHistory(selectedWorkspaceId)
      .then((msgs) => {
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

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  if (!ws) return null;

  const handleSend = async (messageOverride?: string) => {
    const content = (messageOverride ?? chatInput).trim();
    if (!content || !selectedWorkspaceId) return;

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[selectedWorkspaceId] ??= []);
    history.push(content);
    historyIndexRef.current = -1;
    draftRef.current = "";

    setChatInput("");
    addChatMessage(selectedWorkspaceId, {
      id: crypto.randomUUID(),
      workspace_id: selectedWorkspaceId,
      role: "User",
      content,
      cost_usd: null,
      duration_ms: null,
      created_at: new Date().toISOString(),
    });
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });

    try {
      await sendChatMessage(selectedWorkspaceId, content, permissionLevel);
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
      await stopAgent(selectedWorkspaceId);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Stopped" });
    } catch (e) {
      console.error("stopAgent failed:", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (!selectedWorkspaceId) return;
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
            onClick={() => selectWorkspace(null)}
            title="Back to dashboard"
            type="button"
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
          <select
            className={styles.permissionSelect}
            value={permissionLevel}
            onChange={async (e) => {
              if (!selectedWorkspaceId) return;
              const previous = permissionLevel;
              const level = e.target.value as "readonly" | "standard" | "full";
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
            disabled={isRunning}
            title="Tool permission level for this workspace"
            aria-label="Tool permission level for this workspace"
          >
            <option value="readonly">Read-only</option>
            <option value="standard">Standard</option>
            <option value="full">Full access</option>
          </select>
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

        {messages.length === 0 && !streaming ? (
          <div className={styles.empty}>
            Send a message to start a conversation
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`${styles.message} ${styles[`role_${msg.role}`]}`}
              >
                <div className={styles.roleLabel}>
                  {msg.role === "User"
                    ? "You"
                    : msg.role === "Assistant"
                      ? "Claude"
                      : "System"}
                </div>
                <div className={styles.content}>
                  {msg.role === "Assistant" ? (
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </Markdown>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {completedTurns.map((turn, ti) => (
              <div
                key={turn.id}
                className={styles.turnSummary}
                role="button"
                tabIndex={0}
                onClick={() =>
                  selectedWorkspaceId &&
                  toggleCompletedTurn(selectedWorkspaceId, ti)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectedWorkspaceId &&
                      toggleCompletedTurn(selectedWorkspaceId, ti);
                  }
                }}
              >
                <div className={styles.turnHeader}>
                  <span className={styles.toolChevron}>
                    {turn.collapsed ? "›" : "⌄"}
                  </span>
                  <span className={styles.turnLabel}>
                    {turn.activities.length} tool call
                    {turn.activities.length !== 1 ? "s" : ""}
                    {turn.messageCount > 0 &&
                      `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
                  </span>
                </div>
                {!turn.collapsed && (
                  <div className={styles.turnActivities}>
                    {turn.activities.map((act) => (
                      <div
                        key={act.toolUseId}
                        className={styles.toolActivity}
                      >
                        <div className={styles.toolHeader}>
                          <span className={styles.toolName}>
                            {act.toolName}
                          </span>
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
            ))}

            {activities.length > 0 && (
              <div className={styles.toolActivities}>
                {activities.map((act, i) => (
                  <div key={act.toolUseId} className={styles.toolActivity}>
                    <button
                      className={styles.toolHeader}
                      onClick={() =>
                        selectedWorkspaceId &&
                        toggleToolActivityCollapsed(selectedWorkspaceId, i)
                      }
                    >
                      <span className={styles.toolChevron}>
                        {act.collapsed ? ">" : "v"}
                      </span>
                      <span className={styles.toolName}>{act.toolName}</span>
                      {act.summary && (
                        <span className={styles.toolSummary}>
                          {act.summary}
                        </span>
                      )}
                    </button>
                    {!act.collapsed && (
                      <pre className={styles.toolContent}>
                        {act.resultText || act.inputJson || "..."}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            {streaming && (
              <div className={`${styles.message} ${styles.role_Assistant}`}>
                <div className={styles.roleLabel}>Claude</div>
                <div className={styles.content}>
                  <Markdown remarkPlugins={[remarkGfm]}>{streaming}</Markdown>
                  <span className={styles.cursor}>|</span>
                </div>
              </div>
            )}

            {isRunning && !pendingQuestion && (
              <div
                className={styles.processing}
                role="status"
                aria-label={`Processing, ${formatElapsed(elapsed)} elapsed`}
              >
                <span className={styles.spinner} aria-hidden="true">{SPINNER_FRAMES[spinnerIdx]}</span>
                <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
              </div>
            )}

            {pendingQuestion && (
              <AgentQuestionCard
                question={pendingQuestion}
                onRespond={(response) => {
                  setAgentQuestion(null);
                  handleSend(response);
                }}
              />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <textarea
          className={styles.input}
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={() => handleSend()}
          disabled={!chatInput.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
