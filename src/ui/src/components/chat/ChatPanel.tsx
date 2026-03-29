import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadChatHistory,
  sendChatMessage,
  stopAgent,
} from "../../services/tauri";
import { useAgentStream } from "../../hooks/useAgentStream";
import styles from "./ChatPanel.module.css";

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

  useAgentStream();

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const messages = selectedWorkspaceId
    ? chatMessages[selectedWorkspaceId] || []
    : [];
  const streaming = selectedWorkspaceId
    ? streamingContent[selectedWorkspaceId] || ""
    : "";
  const activities = selectedWorkspaceId
    ? toolActivities[selectedWorkspaceId] || []
    : [];
  const isRunning = ws?.agent_status === "Running";

  // Load chat history when workspace changes
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    loadChatHistory(selectedWorkspaceId).then((msgs) => {
      setChatMessages(selectedWorkspaceId, msgs);
    });
  }, [selectedWorkspaceId, setChatMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  if (!ws) return null;

  const handleSend = async () => {
    const content = chatInput.trim();
    if (!content || !selectedWorkspaceId) return;

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
      await sendChatMessage(selectedWorkspaceId, content);
    } catch (e) {
      updateWorkspace(selectedWorkspaceId, {
        agent_status: { Error: String(e) },
      });
    }
  };

  const handleStop = async () => {
    if (!selectedWorkspaceId) return;
    try {
      await stopAgent(selectedWorkspaceId);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Stopped" });
    } catch {
      // ignore
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.wsName}>{ws.name}</span>
          {repo && <span className={styles.repoName}>{repo.name}</span>}
        </div>
        <div className={styles.headerRight}>
          <span
            className={styles.statusBadge}
            style={{
              color: isRunning
                ? "var(--status-running)"
                : "var(--status-idle)",
            }}
          >
            {typeof ws.agent_status === "string"
              ? ws.agent_status
              : "Error"}
          </span>
          {isRunning ? (
            <button className={styles.stopBtn} onClick={handleStop}>
              Stop
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.messages}>
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

            {isRunning && !streaming && (
              <div className={styles.processing}>Processing...</div>
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
          onClick={handleSend}
          disabled={!chatInput.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
