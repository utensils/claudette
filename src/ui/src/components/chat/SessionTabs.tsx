import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDiff as FileDiffIcon, Plus, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  archiveChatSession,
} from "../../services/tauri";
import { SessionStatusIcon, type SessionStatusKind } from "../shared/SessionStatusIcon";
import type { ChatSession, DiffFileTab, DiffLayer } from "../../types";
import styles from "./SessionTabs.module.css";

type NavDirection = "prev" | "next" | "first" | "last";

// Unified key namespace for the tab strip's keyboard nav and ref map.
// Sessions and diff tabs occupy a single ordered list; encoding the kind in
// the key keeps the navigation logic flat without touching the underlying
// data shapes.
const sessionNavKey = (id: string) => `s:${id}`;
const diffNavKey = (path: string, layer: DiffLayer | null) =>
  `d:${path}:${layer ?? "null"}`;

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
const EMPTY_DIFF_TABS: DiffFileTab[] = [];

export function SessionTabs({ workspaceId }: Props) {
  const { t } = useTranslation("chat");
  const sessions = useAppStore(
    (s) => s.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS,
  );
  const selectedSessionId = useAppStore(
    (s) => s.selectedSessionIdByWorkspaceId[workspaceId] ?? null,
  );
  const diffTabs = useAppStore(
    (s) => s.diffTabsByWorkspace[workspaceId] ?? EMPTY_DIFF_TABS,
  );
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffSelectedLayer = useAppStore((s) => s.diffSelectedLayer);
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const addChatSession = useAppStore((s) => s.addChatSession);
  const updateChatSession = useAppStore((s) => s.updateChatSession);
  const removeChatSession = useAppStore((s) => s.removeChatSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const selectDiffTab = useAppStore((s) => s.selectDiffTab);
  const closeDiffTab = useAppStore((s) => s.closeDiffTab);

  // Monotonic version token: each local mutation (create/archive) bumps this so
  // an in-flight `listChatSessions` response can detect it's stale and skip the
  // overwrite. Without this, a create+archive that races with the initial load
  // can get stomped by the older snapshot.
  const loadVersionRef = useRef(0);

  // Load sessions for this workspace on mount / workspace change.
  useEffect(() => {
    const version = ++loadVersionRef.current;
    listChatSessions(workspaceId, false)
      .then((sessions) => {
        if (version === loadVersionRef.current) {
          setSessionsForWorkspace(workspaceId, sessions);
        }
      })
      .catch((err) => {
        console.error("[SessionTabs] Failed to load sessions:", err);
      });
  }, [workspaceId, setSessionsForWorkspace]);

  // Memoized so navEntries / navigateTabs stay referentially stable when the
  // session list hasn't changed — without this, `sessions.filter` returns a
  // fresh array each render and defeats the downstream useMemo/useCallback.
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === "Active"),
    [sessions],
  );

  const handleCreate = async () => {
    try {
      const session = await createChatSession(workspaceId);
      // Invalidate any in-flight load — our local addChatSession is authoritative.
      loadVersionRef.current += 1;
      addChatSession(session);
      selectSession(workspaceId, session.id);
    } catch (err) {
      console.error("[SessionTabs] Failed to create session:", err);
    }
  };

  const handleArchive = async (session: ChatSession) => {
    if (session.agent_status === "Running") {
      const ok = window.confirm(
        t("session_running_confirm_close", { name: session.name }),
      );
      if (!ok) return;
    }
    try {
      const autoCreated = await archiveChatSession(session.id);
      loadVersionRef.current += 1;
      removeChatSession(session.id);
      if (autoCreated) {
        addChatSession(autoCreated);
        selectSession(workspaceId, autoCreated.id);
      }
    } catch (err) {
      console.error("[SessionTabs] Failed to archive session:", err);
    }
  };

  // Refs keyed by a unified nav key (sessionNavKey / diffNavKey) so arrow-key
  // navigation can focus any tab in the strip, regardless of kind.
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Unified ordered list of focusable tab entries. Sessions first, diffs
  // second — the layout users see in the strip. Wrapped in useMemo so the
  // navigateTabs callback identity stays stable across unrelated re-renders.
  type NavEntry =
    | { key: string; kind: "session"; sessionId: string }
    | { key: string; kind: "diff"; path: string; layer: DiffLayer | null };
  const navEntries = useMemo<NavEntry[]>(() => {
    const sessionEntries: NavEntry[] = activeSessions.map((s) => ({
      key: sessionNavKey(s.id),
      kind: "session",
      sessionId: s.id,
    }));
    const diffEntries: NavEntry[] = diffTabs.map((t) => ({
      key: diffNavKey(t.path, t.layer),
      kind: "diff",
      path: t.path,
      layer: t.layer,
    }));
    return [...sessionEntries, ...diffEntries];
  }, [activeSessions, diffTabs]);

  const navigateTabs = useCallback(
    (fromKey: string, direction: NavDirection) => {
      if (navEntries.length === 0) return;
      const idx = navEntries.findIndex((e) => e.key === fromKey);
      if (idx < 0) return;
      let targetIdx: number;
      switch (direction) {
        case "prev":
          targetIdx = (idx - 1 + navEntries.length) % navEntries.length;
          break;
        case "next":
          targetIdx = (idx + 1) % navEntries.length;
          break;
        case "first":
          targetIdx = 0;
          break;
        case "last":
          targetIdx = navEntries.length - 1;
          break;
      }
      const target = navEntries[targetIdx];
      if (target.kind === "session") {
        selectSession(workspaceId, target.sessionId);
      } else {
        selectDiffTab(target.path, target.layer);
      }
      tabRefs.current.get(target.key)?.focus();
    },
    [navEntries, selectSession, selectDiffTab, workspaceId],
  );

  return (
    <div className={styles.tabBar} role="tablist">
      {activeSessions.map((session) => {
        const navKey = sessionNavKey(session.id);
        return (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === selectedSessionId && diffSelectedFile === null}
            onSelect={() => selectSession(workspaceId, session.id)}
            onClose={() => handleArchive(session)}
            onRename={(name) => {
              updateChatSession(session.id, { name, name_edited: true });
            }}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            tabRef={(el) => {
              if (el) tabRefs.current.set(navKey, el);
              else tabRefs.current.delete(navKey);
            }}
          />
        );
      })}
      {diffTabs.map((tab) => {
        const navKey = diffNavKey(tab.path, tab.layer);
        const isActive =
          diffSelectedFile === tab.path && diffSelectedLayer === tab.layer;
        return (
          <DiffTab
            key={navKey}
            tab={tab}
            isActive={isActive}
            onSelect={() => selectDiffTab(tab.path, tab.layer)}
            onClose={() => closeDiffTab(workspaceId, tab.path, tab.layer)}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            tabRef={(el) => {
              if (el) tabRefs.current.set(navKey, el);
              else tabRefs.current.delete(navKey);
            }}
          />
        );
      })}
      <button
        type="button"
        className={styles.addBtn}
        onClick={handleCreate}
        title={t("session_new")}
        aria-label={t("session_new")}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

interface TabProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onNavigate: (direction: "prev" | "next" | "first" | "last") => void;
  tabRef: (el: HTMLDivElement | null) => void;
}

function SessionTab({
  session,
  isActive,
  onSelect,
  onClose,
  onRename,
  onNavigate,
  tabRef,
}: TabProps) {
  const { t } = useTranslation("chat");
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
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className={`${styles.tab} ${isActive ? styles.active : ""}`}
      onClick={() => {
        if (!editing) onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          startEditing();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNavigate("prev");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNavigate("next");
        } else if (e.key === "Home") {
          e.preventDefault();
          onNavigate("first");
        } else if (e.key === "End") {
          e.preventDefault();
          onNavigate("last");
        }
      }}
    >
      <span className={`${styles.icon} ${session.needs_attention ? styles.pulse : ""}`}>
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
        title={t("session_close")}
        aria-label={t("session_close")}
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface DiffTabProps {
  tab: DiffFileTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onNavigate: (direction: NavDirection) => void;
  tabRef: (el: HTMLDivElement | null) => void;
}

function DiffTab({ tab, isActive, onSelect, onClose, onNavigate, tabRef }: DiffTabProps) {
  const { t } = useTranslation("chat");
  // Show just the basename in the tab; the full path goes in the tooltip
  // (mirrors how editors label file tabs). `path.split("/").pop()` is fine
  // because diff paths come from git and use forward slashes on every
  // platform.
  const basename = tab.path.split("/").pop() || tab.path;
  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className={`${styles.tab} ${isActive ? styles.active : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNavigate("prev");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNavigate("next");
        } else if (e.key === "Home") {
          e.preventDefault();
          onNavigate("first");
        } else if (e.key === "End") {
          e.preventDefault();
          onNavigate("last");
        }
      }}
    >
      <span className={styles.icon}>
        <FileDiffIcon size={12} />
      </span>
      <span className={styles.name} title={tab.path}>
        {basename}
      </span>
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={t("session_close_diff")}
        aria-label={t("session_close_diff")}
      >
        <X size={12} />
      </button>
    </div>
  );
}
