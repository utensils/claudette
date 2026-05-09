/**
 * Context-aware hotkey actions for the workspace tab strip.
 *
 * Two operations are wired here — "new tab" (Cmd/Ctrl+T) and "close
 * tab" (Cmd/Ctrl+W) — and both share the same routing rule: act on
 * whichever surface is currently active in the right pane (file
 * viewer / diff viewer / chat). Centralising the routing keeps the
 * keyboard shortcut hook (`useKeyboardShortcuts`) and Monaco's
 * `editor.addCommand` overrides honest about each other; without
 * this module, Monaco-vs-window-listener divergence is exactly how
 * Cmd+T silently went missing inside the editor (Monaco's default
 * "Go To Symbol" binding intercepts the keystroke before the window
 * listener fires).
 *
 * The helpers are intentionally pure-ish: they read a snapshot from
 * the zustand store, dispatch slice actions / Tauri service calls,
 * and accept overrides for the side-effecting bits (`confirm`, the
 * chat-session create/archive services) so the unit tests can
 * exercise every routing branch without touching the real backend.
 */

import { ask } from "@tauri-apps/plugin-dialog";
import {
  archiveChatSession as archiveChatSessionService,
  createChatSession as createChatSessionService,
} from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type { ChatSession } from "../types/chat";

export interface ContextActionDeps {
  /** Override the new-session backend call; tests pass a stub.
   *  Defaults to the real Tauri command. */
  createChatSession: typeof createChatSessionService;
  /** Override the archive backend call. */
  archiveChatSession: typeof archiveChatSessionService;
  /** Async yes/no prompt. The default routes through Tauri's
   *  `@tauri-apps/plugin-dialog`'s `ask()` so a real native dialog
   *  appears — `window.confirm()` in Tauri 2 webviews is a silent
   *  no-op that returns immediately and the user never sees the
   *  prompt. Tests pass a stub that resolves to the predetermined
   *  answer (and can synchronize on the resolution). */
  confirm: (message: string) => Promise<boolean>;
}

const DEFAULT_DEPS: ContextActionDeps = {
  createChatSession: createChatSessionService,
  archiveChatSession: archiveChatSessionService,
  confirm: (message) =>
    ask(message, {
      title: "Close session",
      kind: "warning",
      okLabel: "Close",
      cancelLabel: "Cancel",
    }),
};

function resolveDeps(overrides?: Partial<ContextActionDeps>): ContextActionDeps {
  return overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

/**
 * English fallback prompts for the hotkey path. The close-button path
 * in `SessionTabs` uses the i18n-aware `t(...)` lookup; this fallback
 * exists because Monaco's `editor.addCommand` runs outside React's
 * tree and so can't reach react-i18next without extra plumbing. The
 * hotkey is rare enough that the fallback drift from translated
 * locales is acceptable for now — track localising the hotkey path
 * separately if it becomes a real issue.
 */
function formatChatCloseFallbackPrompt(
  kind: Exclude<ChatCloseConfirmKind, "none">,
  name: string,
): string {
  switch (kind) {
    case "running":
      return `This session is still running. Stop and close "${name}"?`;
    case "active":
      return `Close active session "${name}"?`;
    case "last":
      return `Close the only remaining session "${name}"?`;
  }
}

/**
 * Why a chat-close should prompt before archiving. Three triggers,
 * priority-ordered so the most-impactful reason wins when several
 * apply (e.g. the only-running-and-also-only-session case prompts as
 * `"running"`):
 *
 *   - `"running"`: the agent is still mid-turn. Closing kills it.
 *   - `"active"`: the user is currently looking at this session.
 *     Closing yanks the visible chat out from under them.
 *   - `"last"`: this is the only Active session in the workspace.
 *     Closing forces the backend's auto-create path; the existing
 *     history is archived, not deleted, but visually it disappears.
 *
 * Returns `"none"` when the close is incidental (close button on a
 * non-active, non-last, non-running tab) so callers can short-circuit
 * the prompt entirely.
 *
 * Strings live in the caller because i18n's `t(...)` lookup needs the
 * react-i18next context, which this module — used from both React
 * components and Monaco's `editor.addCommand` — can't assume.
 */
export type ChatCloseConfirmKind = "none" | "running" | "active" | "last";

export function chatCloseConfirmKind(args: {
  session: ChatSession;
  activeSessions: readonly ChatSession[];
  isActiveSession: boolean;
}): ChatCloseConfirmKind {
  const { session, activeSessions, isActiveSession } = args;
  if (session.agent_status === "Running") return "running";
  const activeCount = activeSessions.filter((s) => s.status === "Active").length;
  if (isActiveSession) return "active";
  if (activeCount <= 1) return "last";
  return "none";
}

/**
 * Cmd/Ctrl+T — context-aware "new tab".
 *
 *   - File context (a file tab is the active right-pane surface):
 *     trigger the FilesPanel inline-create flow at the workspace root.
 *     Unhides + switches the right sidebar so the inline editor is
 *     actually visible.
 *   - Otherwise (chat or diff): create a fresh chat session in the
 *     current workspace and switch to it.
 *
 * Returns immediately when no workspace is selected; the caller
 * doesn't need to guard.
 */
export function executeNewTab(overrides?: Partial<ContextActionDeps>): void {
  const deps = resolveDeps(overrides);
  const store = useAppStore.getState();
  const wsId = store.selectedWorkspaceId;
  if (!wsId) return;

  const activeFile = store.activeFileTabByWorkspace[wsId] ?? null;
  if (activeFile) {
    if (!store.rightSidebarVisible) store.toggleRightSidebar();
    if (store.rightSidebarTab !== "files") store.setRightSidebarTab("files");
    store.requestNewFileAtRoot(wsId);
    return;
  }

  void (async () => {
    try {
      const session = await deps.createChatSession(wsId);
      const post = useAppStore.getState();
      // Workspace switch between dispatch and resolution → drop.
      if (post.selectedWorkspaceId !== wsId) return;
      post.addChatSession(session);
      post.selectSession(wsId, session.id);
    } catch (err) {
      console.error("[hotkey] executeNewTab failed:", err);
    }
  })();
}

/**
 * Cmd/Ctrl+W — context-aware "close tab".
 *
 *   - File active: route through `requestCloseActiveFileTab` so the
 *     FileViewer's existing dirty-check + discard-confirm flow runs.
 *   - Diff active: directly close the diff tab (no in-flight state to
 *     protect).
 *   - Chat: archive the active session, gated by the shared
 *     `chatCloseConfirmMessage` rules. Auto-creates a fresh session
 *     when archiving the only-remaining one (mirrors the close-button
 *     path in `SessionTabs.handleArchive`).
 *
 * The terminal pane has its own scoped `terminal.close-pane` action
 * dispatched from a different listener, so this function never runs
 * with terminal focus.
 */
export function executeCloseTab(overrides?: Partial<ContextActionDeps>): void {
  const deps = resolveDeps(overrides);
  const store = useAppStore.getState();
  const wsId = store.selectedWorkspaceId;
  if (!wsId) return;

  // 1. File context wins. The slice nonce reaches the mounted
  //    FileViewer, which retains the dirty-buffer modal logic.
  const activeFile = store.activeFileTabByWorkspace[wsId] ?? null;
  if (activeFile) {
    store.requestCloseActiveFileTab(wsId);
    return;
  }

  // 2. Diff context next.
  if (store.diffSelectedFile) {
    store.closeDiffTab(wsId, store.diffSelectedFile, store.diffSelectedLayer);
    return;
  }

  // 3. Chat: archive the currently-selected session if any.
  const sessionId = store.selectedSessionIdByWorkspaceId[wsId];
  if (!sessionId) return;
  const sessions = store.sessionsByWorkspace[wsId] ?? [];
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // The hotkey path always targets the active session (there is no
  // non-active "tab under the cursor" the way the close-button has),
  // so `running`/`active`/`last` all matter; only "none" skips the
  // prompt. Strings are intentionally minimal here — the i18n-aware
  // close button in SessionTabs uses translated copy via the same
  // `chatCloseConfirmKind` helper.
  const kind = chatCloseConfirmKind({
    session,
    activeSessions: sessions,
    isActiveSession: true,
  });

  // The whole flow is async because Tauri's native ask() returns a
  // Promise — sync `window.confirm` is a no-op in the webview, which
  // is why earlier dogfooding reported Cmd+W killing running sessions
  // without any prompt at all.
  void (async () => {
    if (kind !== "none") {
      const message = formatChatCloseFallbackPrompt(kind, session.name);
      let ok: boolean;
      try {
        ok = await deps.confirm(message);
      } catch (err) {
        console.error("[hotkey] confirm dialog failed:", err);
        return;
      }
      if (!ok) return;
    }

    // Re-read the store because the user may have switched sessions
    // while the modal was up. If the active session changed mid-flight
    // we drop the action — closing a session the user is no longer
    // viewing would be the surprise we set out to prevent.
    const stillActive = useAppStore.getState();
    if (
      stillActive.selectedWorkspaceId !== wsId ||
      stillActive.selectedSessionIdByWorkspaceId[wsId] !== sessionId
    ) {
      return;
    }

    try {
      const autoCreated = await deps.archiveChatSession(sessionId);
      const post = useAppStore.getState();
      post.removeChatSession(sessionId);
      if (autoCreated && post.selectedWorkspaceId === wsId) {
        post.addChatSession(autoCreated);
        post.selectSession(wsId, autoCreated.id);
      }
    } catch (err) {
      console.error("[hotkey] executeCloseTab failed:", err);
    }
  })();
}
