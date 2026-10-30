import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/useAppStore";
import {
  archiveChatSession,
  createChatSession,
  listChatSessions,
} from "../../services/tauri";
import { chatCloseConfirmKind } from "../../hotkeys/contextActions";
import { createSerialGate } from "../../utils/serialGate";
import type { ChatSession, DiffFileTab } from "../../types";
import type { NavEntry } from "./sessionTabsLogic";

/** Tauri's native confirm dialog. Used everywhere the close-tab UI
 *  asks the user to confirm — `window.confirm()` is a silent no-op
 *  in Tauri 2 webviews and was the cause of the "Cmd+W kills running
 *  sessions without prompting" regression. */
async function askToClose(message: string): Promise<boolean> {
  return ask(message, {
    title: "Close session",
    kind: "warning",
    okLabel: "Close",
    cancelLabel: "Cancel",
  });
}

interface UseSessionTabActionsArgs {
  workspaceId: string;
  activeSessions: ChatSession[];
  activeSessionById: Map<string, ChatSession>;
  diffTabs: DiffFileTab[];
  fileTabs: string[];
  selectedSessionId: string | null;
  switchToSession: (sessionId: string) => void;
  /** Closes clean file tabs and queues dirty ones behind the discard prompt. */
  requestCloseFileTabsBatch: (paths: string[]) => boolean;
}

/**
 * Session lifecycle for the workspace tab strip: initial load, "+" create
 * (serial-gated), per-tab archive with close confirmation, and the bulk
 * `closeEntries` used by the tab context menu.
 */
export function useSessionTabActions({
  workspaceId,
  activeSessions,
  activeSessionById,
  diffTabs,
  fileTabs,
  selectedSessionId,
  switchToSession,
  requestCloseFileTabsBatch,
}: UseSessionTabActionsArgs) {
  const { t } = useTranslation("chat");
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const markSessionsLoaded = useAppStore((s) => s.markSessionsLoaded);
  const addChatSession = useAppStore((s) => s.addChatSession);
  const removeChatSession = useAppStore((s) => s.removeChatSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const closeDiffTab = useAppStore((s) => s.closeDiffTab);

  // Monotonic version token: each local mutation (create/archive) bumps this so
  // an in-flight `listChatSessions` response can detect it's stale and skip the
  // overwrite. Without this, a create+archive that races with the initial load
  // can get stomped by the older snapshot.
  const loadVersionRef = useRef(0);

  // Defang rapid clicks on the "+ new session" button. Without the gate, a
  // user mashing the button while `createChatSession` is in flight would
  // queue every click as a separate tab once the backend caught up.
  // Issue 574 made this trivial to repro because the streaming task
  // could starve the create command for the duration of an entire turn.
  // We keep both pieces of state because each is load-bearing:
  //  - `gateRef` is the synchronous source of truth (a `useState` setter
  //    only takes effect after the next render, so two clicks in the same
  //    tick would both observe `false`).
  //  - `creating` drives the disabled prop / aria-busy on the button so
  //    the user gets immediate visual feedback.
  const gateRef = useRef(createSerialGate());
  const [creating, setCreating] = useState(false);

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
        // Don't strand ChatPanel on the loading shell when the initial
        // fetch fails — flip the loaded flag so the user falls through
        // to `WorkspaceEmptyTabs` and can recover via "+ Open new session".
        // We deliberately don't overwrite `sessionsByWorkspace` here: a
        // racing `addChatSession` (e.g. an agent stream event mid-fetch)
        // may have already populated the list, and that authoritative
        // state must not be clobbered by the error path.
        if (version === loadVersionRef.current) {
          markSessionsLoaded(workspaceId);
        }
      });
  }, [workspaceId, setSessionsForWorkspace, markSessionsLoaded]);

  const handleCreate = async () => {
    // Drive `setCreating` from inside the gated callback so it only fires
    // for the call that actually acquires the gate. If a second click
    // somehow slipped past the synchronous `isPending()` check, gate.run
    // would return `null` immediately for it and that caller wouldn't
    // touch the visual state — leaving the in-flight call's `creating=true`
    // intact for the duration of the real request.
    try {
      const session = await gateRef.current.run(async () => {
        setCreating(true);
        try {
          return await createChatSession(workspaceId);
        } finally {
          setCreating(false);
        }
      });
      if (session !== null) {
        // Invalidate any in-flight load — our local addChatSession is authoritative.
        loadVersionRef.current += 1;
        addChatSession(session);
        switchToSession(session.id);
      }
    } catch (err) {
      console.error("[SessionTabs] Failed to create session:", err);
    }
  };

  const archiveSessionImmediate = useCallback(
    async (session: ChatSession) => {
      try {
        // Decide whether the backend should auto-create a replacement. We
        // skip the replacement only when this is the LAST tab in the
        // workspace across every kind (chat sessions, diff tabs, file tabs)
        // — that's the "close the final tab and land on the empty-tabs
        // view" path. As long as some other tab is still around, keeping
        // the always-≥1-active-session invariant matches existing UX.
        const isLastSession = activeSessions.length <= 1;
        const noOtherTabs = diffTabs.length === 0 && fileTabs.length === 0;
        const autoReplace = !(isLastSession && noOtherTabs);
        const autoCreated = await archiveChatSession(session.id, autoReplace);
        loadVersionRef.current += 1;
        removeChatSession(session.id);
        if (autoCreated) {
          addChatSession(autoCreated);
          // Only navigate to the new session when the diff panel isn't active —
          // bulk-closing sessions while a diff tab is focused should leave the
          // diff view undisturbed.
          if (useAppStore.getState().diffSelectedFile === null) {
            selectSession(workspaceId, autoCreated.id);
          }
        }
      } catch (err) {
        console.error("[SessionTabs] Failed to archive session:", err);
      }
    },
    [removeChatSession, addChatSession, selectSession, workspaceId, activeSessions, diffTabs, fileTabs],
  );

  const handleArchive = async (session: ChatSession) => {
    // The shared `chatCloseConfirmKind` helper is also used by the
    // global Cmd+W path in `hotkeys/contextActions.ts`, so the rules
    // ("running" / "active" / "last" → confirm) stay in lockstep
    // between the close button and the keystroke. Each kind maps to
    // its own translated string so the message matches the trigger.
    // Pull draft + pending-attachment state for the placeholder-skip
    // guard inside chatCloseConfirmKind: a brand-new "New chat" with
    // unsent typing in the composer must still trip the confirm dialog
    // — letting the close button silently archive that session would
    // discard the user's work-in-progress.
    const storeNow = useAppStore.getState();
    const draft = storeNow.chatDrafts[session.id] ?? null;
    const pendingAttachmentsCount =
      (storeNow.pendingAttachmentsBySession[session.id] ?? []).length;
    const kind = chatCloseConfirmKind({
      session,
      activeSessions,
      isActiveSession: session.id === selectedSessionId,
      draft,
      pendingAttachmentsCount,
    });
    if (kind !== "none") {
      const message =
        kind === "running"
          ? t("session_running_confirm_close", { name: session.name })
          : kind === "active"
            ? t("session_active_confirm_close", { name: session.name })
            : t("session_last_confirm_close", { name: session.name });
      if (!(await askToClose(message))) return;
    }
    await archiveSessionImmediate(session);
  };

  // Close a list of tabs (sessions, diffs, and/or files) sequentially. Sessions
  // get archived through the same backend command as the close button; diffs
  // and files drop from the local store (file tabs route through the
  // dirty-confirm modal).
  //
  // Confirmation rules mirror the per-tab close path's
  // `chatCloseConfirmKind` (running / active / last / none) but
  // aggregate across the batch so the user sees one prompt — not one
  // per tab — when bulk-closing. Priority order:
  //
  //   1. Any running session in the batch → "running" prompt (kept
  //      verbatim; the multi-running plural string already exists).
  //   2. Batch contains the currently-selected session → "active"
  //      prompt (NEW; previously only the single-tab path guarded
  //      this case, leaving Cmd+Shift+W "close all" able to silently
  //      yank the visible chat).
  //   3. Batch closes every Active session in the workspace → "last"
  //      prompt (NEW; the auto-create path runs and the visible
  //      history archives away).
  const closeEntries = useCallback(
    async (entries: NavEntry[]) => {
      if (entries.length === 0) return;
      const sessionEntries = entries.flatMap((e) =>
        e.kind === "session" ? [e] : [],
      );
      const sessionsBeingClosed = sessionEntries
        .map((e) => activeSessionById.get(e.sessionId))
        .filter((s): s is ChatSession => !!s);
      const runningSessions = sessionsBeingClosed.filter(
        (s) => s.agent_status === "Running",
      );
      const closingActive = sessionsBeingClosed.some(
        (s) => s.id === selectedSessionId,
      );
      const remainingActiveAfterBatch =
        activeSessions.length - sessionsBeingClosed.length;

      if (runningSessions.length > 0) {
        const message =
          runningSessions.length === 1
            ? t("session_running_confirm_close", { name: runningSessions[0].name })
            : t("session_running_confirm_close_multi", { count: runningSessions.length });
        if (!(await askToClose(message))) return;
      } else if (closingActive) {
        const active = sessionsBeingClosed.find(
          (s) => s.id === selectedSessionId,
        );
        if (
          active &&
          !(await askToClose(
            t("session_active_confirm_close", { name: active.name }),
          ))
        )
          return;
      } else if (
        sessionsBeingClosed.length > 0 &&
        remainingActiveAfterBatch <= 0
      ) {
        // Batch wipes out every Active session — surface the last-one
        // prompt against any of them (pick the first; user can still
        // cancel the whole batch).
        const last = sessionsBeingClosed[0];
        if (
          last &&
          !(await askToClose(
            t("session_last_confirm_close", { name: last.name }),
          ))
        )
          return;
      }

      // File tabs: collect first, close clean ones immediately, route
      // dirty ones through a single batched confirm. Sessions and diffs
      // close inline as before.
      const filePaths: string[] = [];
      for (const entry of entries) {
        if (entry.kind === "session") {
          const session = activeSessionById.get(entry.sessionId);
          if (session) await archiveSessionImmediate(session);
        } else if (entry.kind === "diff") {
          closeDiffTab(workspaceId, entry.path, entry.layer);
        } else {
          filePaths.push(entry.path);
        }
      }
      requestCloseFileTabsBatch(filePaths);
    },
    [
      activeSessions,
      activeSessionById,
      archiveSessionImmediate,
      closeDiffTab,
      requestCloseFileTabsBatch,
      selectedSessionId,
      t,
      workspaceId,
    ],
  );

  return { creating, handleCreate, handleArchive, closeEntries };
}
