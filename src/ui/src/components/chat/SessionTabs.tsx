import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  archiveChatSession,
} from "../../services/tauri";
import { SessionStatusIcon, type SessionStatusKind } from "../shared/SessionStatusIcon";
import type { ChatSession } from "../../types";
import styles from "./SessionTabs.module.css";

interface Props {
  workspaceId: string;
}

function statusFor(session: ChatSession): SessionStatusKind {
  if (session.needs_attention) {
    return session.attention_kind === "Plan" ? { kind: "plan" } : { kind: "ask" };
  }
  if (session.agent_status === "Running") return { kind: "running" };
  return { kind: "idle" };
}

// Stable empty array so the selector doesn't return a new `[]` each call when
// this workspace has no sessions loaded yet. `useSyncExternalStore` compares
// consecutive snapshots with `Object.is` and forces a re-render on mismatch;
// a fresh `[]` every call turns that into an infinite render loop.
const EMPTY_SESSIONS: ChatSession[] = [];

export function SessionTabs({ workspaceId }: Props) {
  const sessions = useAppStore(
    (s) => s.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS,
  );
  const selectedSessionId = useAppStore(
    (s) => s.selectedSessionIdByWorkspaceId[workspaceId] ?? null,
  );
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const addChatSession = useAppStore((s) => s.addChatSession);
  const updateChatSession = useAppStore((s) => s.updateChatSession);
  const removeChatSession = useAppStore((s) => s.removeChatSession);
  const selectSession = useAppStore((s) => s.selectSession);

  // Load sessions for this workspace on mount / workspace change.
  useEffect(() => {
    let cancelled = false;
    listChatSessions(workspaceId, false)
      .then((sessions) => {
        if (!cancelled) setSessionsForWorkspace(workspaceId, sessions);
      })
      .catch((err) => {
        console.error("[SessionTabs] Failed to load sessions:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, setSessionsForWorkspace]);

  const activeSessions = sessions.filter((s) => s.status === "Active");
  const runningCount = activeSessions.filter(
    (s) => s.agent_status === "Running",
  ).length;

  const handleCreate = async () => {
    try {
      const session = await createChatSession(workspaceId);
      addChatSession(session);
      selectSession(workspaceId, session.id);
    } catch (err) {
      console.error("[SessionTabs] Failed to create session:", err);
    }
  };

  const handleArchive = async (session: ChatSession) => {
    if (session.agent_status === "Running") {
      const ok = window.confirm(
        `This session is still running. Stop and close "${session.name}"?`,
      );
      if (!ok) return;
    }
    try {
      const autoCreated = await archiveChatSession(session.id);
      removeChatSession(session.id);
      if (autoCreated) {
        addChatSession(autoCreated);
        selectSession(workspaceId, autoCreated.id);
      }
    } catch (err) {
      console.error("[SessionTabs] Failed to archive session:", err);
    }
  };

  return (
    <div className={styles.tabBar} role="tablist">
      {activeSessions.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          isActive={session.id === selectedSessionId}
          onSelect={() => selectSession(workspaceId, session.id)}
          onClose={() => handleArchive(session)}
          onRename={(name) => {
            updateChatSession(session.id, { name, name_edited: true });
          }}
        />
      ))}
      <button
        type="button"
        className={styles.addBtn}
        onClick={handleCreate}
        title="New session (Cmd+T)"
        aria-label="New session"
      >
        <Plus size={14} />
      </button>
      {runningCount > 1 && (
        <span
          className={styles.parallelHint}
          title={`${runningCount} sessions running in parallel`}
          aria-hidden
        >
          <SessionStatusIcon status={{ kind: "running" }} size={10} />
        </span>
      )}
    </div>
  );
}

interface TabProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}

function SessionTab({ session, isActive, onSelect, onClose, onRename }: TabProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(session.name);
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === session.name) {
      setEditing(false);
      setDraft(session.name);
      return;
    }
    try {
      await renameChatSession(session.id, next);
      onRename(next);
    } catch (err) {
      console.error("[SessionTabs] Failed to rename session:", err);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(session.name);
    setEditing(false);
  };

  return (
    <div
      role="tab"
      aria-selected={isActive}
      className={`${styles.tab} ${isActive ? styles.active : ""}`}
      onClick={() => {
        if (!editing) onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
    >
      <span className={styles.icon}>
        <SessionStatusIcon status={statusFor(session)} size={12} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          maxLength={60}
        />
      ) : (
        <span className={styles.name} title={session.name}>
          {session.name}
        </span>
      )}
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close session"
        aria-label="Close session"
      >
        <X size={12} />
      </button>
    </div>
  );
}
