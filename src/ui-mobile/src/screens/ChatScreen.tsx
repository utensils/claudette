import { useEffect, useRef, useState } from "react";
import { loadChatHistory, sendChatMessage, stopAgent } from "../services/rpc";
import { onAgentStream, type AgentStreamPayload } from "../services/events";
import { parseAgentEvent } from "../services/agentStream";
import type {
  ChatMessage,
  ChatSession,
  SavedConnection,
  Workspace,
} from "../types";

interface Props {
  connection: SavedConnection;
  workspace: Workspace;
  session: ChatSession;
  onBack: () => void;
}

// In-flight assistant draft built up from streaming events. Surfaced as
// a transient bubble below the persisted history so the user sees text
// appear as the agent generates it. Cleared on `Result` since the
// server persists the final assistant message and `load_chat_history`
// will replay it on next mount.
interface StreamingDraft {
  text: string;
  thinking: string;
}

export function ChatScreen({ connection, workspace, session, onBack }: Props) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState<StreamingDraft | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load history on mount, and re-load every time the agent finishes a
  // turn so the persisted final messages replace the streaming draft
  // bubble. Cheaper than splicing the assistant message into local
  // state because the server is the source of truth (it deduplicates
  // thinking accumulation, tracks usage, etc.).
  const refreshHistory = async () => {
    try {
      const history = await loadChatHistory(connection.id, session.id);
      setMessages(history);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await onAgentStream(connection.id, (payload) => {
        if (payload.session_id !== session.id) return;
        handleStreamEvent(payload);
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, session.id]);

  const handleStreamEvent = (payload: AgentStreamPayload) => {
    const parsed = parseAgentEvent(payload.event);

    if (parsed.assistantText || parsed.thinkingText) {
      setDraft((prev) => ({
        text: (prev?.text ?? "") + (parsed.assistantText ?? ""),
        thinking: (prev?.thinking ?? "") + (parsed.thinkingText ?? ""),
      }));
      setAgentActive(true);
    }

    if (parsed.turnComplete || parsed.processExited) {
      setDraft(null);
      setAgentActive(false);
      void refreshHistory();
    }
  };

  // Scroll-to-bottom on new messages / draft updates. Smooth scroll feels
  // sluggish on cellular renders, so we use instant for the streaming
  // draft updates and smooth for the post-turn history reload.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, draft]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content) return;
    setError(null);
    setBusy(true);
    setInput("");
    // Optimistically render the user message — the server persists it,
    // and the next `refreshHistory` after the agent completes will
    // canonicalize it. Until then this avoids a "where did my message
    // go" delay on slow networks.
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      workspace_id: workspace.id,
      chat_session_id: session.id,
      role: "User",
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => (prev ? [...prev, optimistic] : [optimistic]));
    try {
      await sendChatMessage(connection.id, session.id, content);
      // Agent stream events from this point on will populate the
      // assistant draft.
      setAgentActive(true);
    } catch (e) {
      setError(String(e));
      setMessages((prev) =>
        prev ? prev.filter((m) => m.id !== optimistic.id) : null,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setError(null);
    try {
      await stopAgent(connection.id, session.id);
      setAgentActive(false);
      setDraft(null);
      void refreshHistory();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="shell">
      <header className="header header-row">
        <button className="ghost-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="header-center">
          <h1>{session.name ?? "Session"}</h1>
          <p className="subtitle">{workspace.name}</p>
        </div>
        {agentActive && (
          <button
            className="ghost-btn"
            onClick={() => void handleStop()}
            aria-label="Stop agent"
          >
            Stop
          </button>
        )}
      </header>
      <div className="chat-body" ref={scrollRef}>
        {error && <div className="error">{error}</div>}
        {messages?.map((m) => (
          <div key={m.id} className={`bubble bubble-${m.role.toLowerCase()}`}>
            <div className="bubble-content">{m.content}</div>
          </div>
        ))}
        {draft && (
          <div className="bubble bubble-assistant bubble-streaming">
            {draft.thinking && (
              <div className="bubble-thinking">{draft.thinking}</div>
            )}
            <div className="bubble-content">{draft.text || "…"}</div>
          </div>
        )}
      </div>
      <footer className="composer">
        <input
          className="paste-input composer-input"
          placeholder="Send a message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={busy}
        />
        <button
          className="primary composer-send"
          onClick={() => void handleSend()}
          disabled={busy || !input.trim()}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </footer>
    </div>
  );
}
