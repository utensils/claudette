import { useEffect, useRef, useState } from "react";
import {
  loadChatHistory,
  sendChatMessage,
  stopAgent,
  submitAgentAnswer,
  submitPlanApproval,
} from "../services/rpc";
import {
  onAgentStream,
  onPermissionPrompt,
  type AgentStreamPayload,
  type PermissionPromptPayload,
} from "../services/events";
import { parseAgentEvent } from "../services/agentStream";
import { AskQuestionSheet, type AskQuestionInput } from "../components/AskQuestionSheet";
import { PlanApprovalCard, type PlanInput } from "../components/PlanApprovalCard";
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
//
// Each StreamEvent::Assistant emits the *full* current content array,
// not a delta. We therefore REPLACE rather than concatenate — appending
// would duplicate the entire prior text on every subsequent assistant
// event, producing increasingly long garbled bubbles.
interface StreamingDraft {
  text: string;
  thinking: string;
}

const DISMISS_REASON = "User dismissed the prompt without responding.";

export function ChatScreen({ connection, workspace, session, onBack }: Props) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState<StreamingDraft | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  // Queue of pending permission prompts. The active prompt is queue[0];
  // a second prompt arriving while the first is open is appended rather
  // than clobbering, so neither the UI nor the server's pending_permissions
  // entry is lost. Most chats only ever have one pending at a time, but
  // a sequential AskUserQuestion + ExitPlanMode flow needs both.
  const [pendingQueue, setPendingQueue] = useState<PermissionPromptPayload[]>(
    [],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingPrompt = pendingQueue[0] ?? null;

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
    let unlistenStream: (() => void) | null = null;
    let unlistenPrompt: (() => void) | null = null;
    void (async () => {
      unlistenStream = await onAgentStream(connection.id, (payload) => {
        if (payload.session_id !== session.id) return;
        handleStreamEvent(payload);
      });
      unlistenPrompt = await onPermissionPrompt(connection.id, (payload) => {
        if (payload.chat_session_id !== session.id) return;
        setPendingQueue((prev) => {
          // De-dupe — if the same tool_use_id is already queued (e.g.
          // a forwarder retry), don't add it twice.
          if (prev.some((p) => p.tool_use_id === payload.tool_use_id)) {
            return prev;
          }
          return [...prev, payload];
        });
      });
    })();
    return () => {
      if (unlistenStream) unlistenStream();
      if (unlistenPrompt) unlistenPrompt();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, session.id]);

  const handleStreamEvent = (payload: AgentStreamPayload) => {
    const parsed = parseAgentEvent(payload.event);

    // Each assistant event carries the *full* current message content,
    // not a delta. Replace rather than append, otherwise the bubble
    // shows duplicated text growing each event. Thinking is treated
    // the same way for consistency.
    if (parsed.assistantText !== null || parsed.thinkingText !== null) {
      setDraft({
        text: parsed.assistantText ?? "",
        thinking: parsed.thinkingText ?? "",
      });
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

  const dequeuePrompt = (toolUseId: string) => {
    setPendingQueue((prev) => prev.filter((p) => p.tool_use_id !== toolUseId));
  };

  const handleAnswerQuestion = async (answers: Record<string, string>) => {
    if (!pendingPrompt) return;
    const tooId = pendingPrompt.tool_use_id;
    await submitAgentAnswer(connection.id, session.id, tooId, answers);
    dequeuePrompt(tooId);
  };

  // Dismiss handler for AskUserQuestion. The agent is mid-turn waiting
  // on a `control_response` — silently dropping the modal would hang the
  // CLI subprocess. Send an empty-answer deny so the agent can either
  // re-ask or surface the situation to itself in plain text.
  const handleDismissAsk = async () => {
    if (!pendingPrompt) return;
    const tooId = pendingPrompt.tool_use_id;
    try {
      // No `submitAgentAnswer` deny path exists today — fall back to
      // `submitPlanApproval(false, reason)` which routes through the
      // generic `submit_agent_approval` deny payload the server
      // accepts. AskUserQuestion isn't in the approval-tool allow-list
      // though, so we use submit_agent_answer with an "I dismissed it"
      // synthetic answer instead.
      await submitAgentAnswer(connection.id, session.id, tooId, {
        __dismissed: DISMISS_REASON,
      });
    } catch (e) {
      // If the server rejects the dismiss, surface it but still drop
      // the prompt locally — the user has indicated they don't want
      // to deal with it, and forcing them to is a worse outcome.
      console.warn("Dismiss-deny failed:", e);
    }
    dequeuePrompt(tooId);
  };

  const handleApprovePlan = async (approved: boolean, reason?: string) => {
    if (!pendingPrompt) return;
    const tooId = pendingPrompt.tool_use_id;
    await submitPlanApproval(
      connection.id,
      session.id,
      tooId,
      approved,
      reason,
    );
    dequeuePrompt(tooId);
  };

  // Dismiss handler for ExitPlanMode. Auto-denies so the agent gets a
  // chance to revise; without this, dismissing the card would leave
  // the CLI subprocess blocked on stdin waiting for a `control_response`.
  const handleDismissPlan = async () => {
    if (!pendingPrompt) return;
    const tooId = pendingPrompt.tool_use_id;
    try {
      await submitPlanApproval(
        connection.id,
        session.id,
        tooId,
        false,
        DISMISS_REASON,
      );
    } catch (e) {
      console.warn("Plan dismiss-deny failed:", e);
    }
    dequeuePrompt(tooId);
  };

  // Back-navigation guard. If a prompt is pending, the agent is hung on
  // stdin waiting for an answer. Leaving without responding would orphan
  // the pending_permissions entry on the server. Auto-deny everything
  // pending before navigating away.
  const handleBack = () => {
    if (pendingQueue.length > 0) {
      void Promise.all(
        pendingQueue.map(async (p) => {
          try {
            if (p.tool_name === "AskUserQuestion") {
              await submitAgentAnswer(connection.id, session.id, p.tool_use_id, {
                __dismissed: DISMISS_REASON,
              });
            } else {
              await submitPlanApproval(
                connection.id,
                session.id,
                p.tool_use_id,
                false,
                DISMISS_REASON,
              );
            }
          } catch (e) {
            console.warn("Auto-deny on back-nav failed:", e);
          }
        }),
      );
      setPendingQueue([]);
    }
    onBack();
  };

  const isAskQuestion = pendingPrompt?.tool_name === "AskUserQuestion";
  const isPlanApproval = pendingPrompt?.tool_name === "ExitPlanMode";

  return (
    <div className="shell">
      <header className="header header-row">
        <button className="ghost-btn" onClick={handleBack}>
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
        {isPlanApproval && pendingPrompt && (
          <PlanApprovalCard
            toolUseId={pendingPrompt.tool_use_id}
            input={(pendingPrompt.input as PlanInput) ?? {}}
            onSubmit={handleApprovePlan}
            onDismiss={handleDismissPlan}
          />
        )}
      </div>
      {isAskQuestion && pendingPrompt && (
        <AskQuestionSheet
          toolUseId={pendingPrompt.tool_use_id}
          input={(pendingPrompt.input as AskQuestionInput) ?? { questions: [] }}
          onSubmit={handleAnswerQuestion}
          onDismiss={handleDismissAsk}
        />
      )}
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
