import { useEffect, useState } from "react";
import { createChatSession, listChatSessions } from "../services/rpc";
import type { ChatSession, SavedConnection, Workspace } from "../types";

interface Props {
  connection: SavedConnection;
  workspace: Workspace;
  onOpenSession: (session: ChatSession) => void;
  onBack: () => void;
}

export function ChatListScreen({
  connection,
  workspace,
  onOpenSession,
  onBack,
}: Props) {
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setError(null);
    try {
      const result = await listChatSessions(connection.id, workspace.id, false);
      setSessions(result);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  const handleNewSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await createChatSession(connection.id, workspace.id);
      // Optimistically open the new session instead of waiting for the
      // user to tap it — matches the desktop's flow.
      onOpenSession(session);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <header className="header header-row">
        <button className="ghost-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="header-center">
          <h1>{workspace.name}</h1>
          <p className="subtitle">{workspace.branch_name}</p>
        </div>
      </header>
      <main className="main">
        {error && <div className="error">{error}</div>}
        {!sessions && !error && <p className="status">Loading sessions…</p>}
        {sessions && sessions.length === 0 && (
          <p className="hint">No chat sessions yet. Start one below.</p>
        )}
        <ul className="conn-list">
          {sessions?.map((s) => (
            <li key={s.id}>
              <button
                className="conn-row-main"
                onClick={() => onOpenSession(s)}
              >
                <span className="conn-name">{s.name ?? "Session"}</span>
                <span className="conn-host">
                  {new Date(s.created_at).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void handleNewSession()}
        >
          {busy ? "Creating…" : "New chat session"}
        </button>
      </main>
    </div>
  );
}
