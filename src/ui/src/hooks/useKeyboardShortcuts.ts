import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { sendRemoteCommand, stopAgent } from "../services/tauri";
import { isAgentBusy } from "../utils/agentStatus";
import {
  focusActiveTerminal,
  focusChatPrompt,
  isTerminalFocused,
} from "../utils/focusTargets";
import { adjustUiFontSize } from "../utils/fontSettings";
import { resolveHotkeyAction } from "../hotkeys/bindings";
import { executeCloseTab, executeNewTab } from "../hotkeys/contextActions";
import type { HotkeyActionId } from "../hotkeys/actions";

export function useKeyboardShortcuts() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleFuzzyFinder = useAppStore((s) => s.toggleFuzzyFinder);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const openCommandPaletteFileMode = useAppStore((s) => s.openCommandPaletteFileMode);
  const openModal = useAppStore((s) => s.openModal);
  const closeModal = useAppStore((s) => s.closeModal);
  const activeModal = useAppStore((s) => s.activeModal);
  const fuzzyFinderOpen = useAppStore((s) => s.fuzzyFinderOpen);
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const planMode = useAppStore(
    (s) => (activeSessionId ? s.planMode[activeSessionId] ?? false : false),
  );
  const chatSearchOpen = useAppStore(
    (s) => (selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.open ?? false : false),
  );
  const openChatSearch = useAppStore((s) => s.openChatSearch);
  const closeChatSearch = useAppStore((s) => s.closeChatSearch);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isInteractive = activeTag === "input" || activeTag === "textarea" ||
        activeTag === "select" || activeTag === "button";
      const action = resolveHotkeyAction(e, "global", state.keybindings);
      if (!action) return;

      // Escape: dismiss topmost overlay, or stop running agent
      if (action === "global.dismiss-or-stop") {
        if (commandPaletteOpen) {
          toggleCommandPalette();
        } else if (activeModal) {
          closeModal();
        } else if (fuzzyFinderOpen) {
          toggleFuzzyFinder();
        } else if (useAppStore.getState().settingsOpen) {
          return;
        } else if (chatSearchOpen && selectedWorkspaceId) {
          // Close the search bar and put focus back in the composer so
          // Esc lands the user where they were before Cmd+F.
          closeChatSearch(selectedWorkspaceId);
          focusChatPrompt();
        } else if (diffSelectedFile) {
          setDiffSelectedFile(null);
        } else if (selectedWorkspaceId) {
          // Stop agent if running (lowest priority, after all overlays)
          const ws = useAppStore.getState().workspaces.find(
            (w) => w.id === selectedWorkspaceId,
          );
          if (ws && isAgentBusy(ws.agent_status)) {
            const sessionId =
              useAppStore.getState().selectedSessionIdByWorkspaceId[
                selectedWorkspaceId
              ];
            if (sessionId) {
              // Clear queued message — user is taking manual control.
              useAppStore.getState().clearQueuedMessage(sessionId);
              // Route through remote or local stop path. `stop_agent` is a
              // per-session command now — pass the active session id.
              const stopPromise = ws.remote_connection_id
                ? sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
                    chat_session_id: sessionId,
                  })
                : stopAgent(sessionId);
              stopPromise.catch(console.error);
              // Don't write workspace-level agent_status here: this stops only
              // the active session. The backend's ProcessExited event will
              // mark this session as Stopped, and useAgentStream re-derives
              // the workspace aggregate from per-session statuses (any session
              // still Running keeps the workspace as Running).
            }
          }
        }
        return;
      }

      const overlayOpen =
        state.settingsOpen || !!state.activeModal || state.commandPaletteOpen || state.fuzzyFinderOpen;
      if (
        overlayOpen &&
        action !== "global.open-settings" &&
        action !== "global.toggle-command-palette" &&
        action !== "global.toggle-fuzzy-finder" &&
        action !== "global.show-keyboard-shortcuts"
      ) return;
      if (action === "global.toggle-plan-mode" && (!activeSessionId || isInteractive)) return;

      const jumpMatch = action.match(/^global\.jump-to-project-(\d)$/);

      if (jumpMatch) {
        e.preventDefault();
        const currentState = useAppStore.getState();
        const localRepos = currentState.repositories.filter((r) => !r.remote_connection_id);
        const idx = parseInt(jumpMatch[1], 10) - 1;
        if (idx < localRepos.length) {
          const repo = localRepos[idx];
          const ws = currentState.workspaces.find(
            (w) => w.repository_id === repo.id && w.status === "Active",
          );
          if (ws) {
            // Backwards-compat path: when the project has at least one
            // active workspace, Cmd+N still lands directly on it.
            currentState.selectWorkspace(ws.id);
          } else {
            // Otherwise the shortcut now opens the project-scoped view —
            // previously it was a no-op for empty projects, which made
            // the shortcut feel broken right after adding a repo.
            currentState.selectRepository(repo.id);
          }
        }
        return;
      }

      const run = (id: HotkeyActionId) => {
        e.preventDefault();
        switch (id) {
          case "global.toggle-plan-mode":
            if (activeSessionId) setPlanMode(activeSessionId, !planMode);
            return;
          case "global.cycle-tab-prev":
            useAppStore.getState().cycleWorkspaceTab("prev");
            return;
          case "global.cycle-tab-next":
            useAppStore.getState().cycleWorkspaceTab("next");
            return;
          case "global.focus-toggle":
            if (isTerminalFocused()) {
              focusChatPrompt();
            } else {
              const store = useAppStore.getState();
              if (!store.terminalPanelVisible) {
                store.toggleTerminalPanel();
                requestAnimationFrame(() => focusActiveTerminal());
              } else {
                focusActiveTerminal();
              }
            }
            return;
          case "global.increase-ui-font":
            adjustUiFontSize(+1);
            return;
          case "global.decrease-ui-font":
            adjustUiFontSize(-1);
            return;
          case "global.open-chat-search":
            if (selectedWorkspaceId) openChatSearch(selectedWorkspaceId);
            return;
          case "global.toggle-sidebar":
            toggleSidebar();
            return;
          case "global.toggle-fuzzy-finder":
            toggleFuzzyFinder();
            return;
          case "global.toggle-command-palette":
            toggleCommandPalette();
            return;
          case "global.open-command-palette-file-mode":
            if (selectedWorkspaceId) openCommandPaletteFileMode();
            return;
          case "global.toggle-right-sidebar":
            toggleRightSidebar();
            return;
          case "global.toggle-terminal-panel":
            toggleTerminalPanel();
            requestAnimationFrame(() => {
              const visible = useAppStore.getState().terminalPanelVisible;
              if (visible) focusActiveTerminal();
              else focusChatPrompt();
            });
            return;
          case "global.open-settings": {
            const store = useAppStore.getState();
            if (store.settingsOpen) store.closeSettings();
            else store.openSettings();
            return;
          }
          case "global.show-keyboard-shortcuts":
            // Idempotent when already open: openModal sets the same id.
            // Esc closes it via the global.dismiss-or-stop branch above.
            openModal("keyboard-shortcuts");
            return;
          case "global.new-tab":
            // Routing logic lives in `hotkeys/contextActions.ts` so the
            // Monaco-side overrides (which bypass this listener via
            // `editor.addCommand`) and the keyboard hook share a
            // single implementation. See that module for the
            // file/diff/chat dispatch table.
            executeNewTab();
            return;
          case "global.close-tab":
            // Same shared module. Includes the dirty-aware close path
            // (via `requestCloseFileTabNonceByWorkspace`) and the
            // chat-close confirmation rules.
            executeCloseTab();
            return;
          case "global.new-workspace": {
            // Resolve the target project: project-scoped view's pinned
            // repo, then the active workspace's repo, finally the first
            // local repo (so the shortcut still works from the global
            // dashboard with a single repo).
            const cur = useAppStore.getState();
            const localRepos = cur.repositories.filter((r) => !r.remote_connection_id);
            const fromScoped = cur.selectedRepositoryId
              ? localRepos.find((r) => r.id === cur.selectedRepositoryId)
              : null;
            const fromWorkspace = (() => {
              if (!cur.selectedWorkspaceId) return null;
              const ws = cur.workspaces.find((w) => w.id === cur.selectedWorkspaceId);
              return ws ? localRepos.find((r) => r.id === ws.repository_id) : null;
            })();
            const target = fromScoped ?? fromWorkspace ?? localRepos[0] ?? null;
            if (!target) return;
            // Lazy import keeps the workspace-creation orchestration out
            // of this hook's main bundle (it pulls in setup-script flow
            // and confirm-modal data). The dynamic import resolves once
            // and is cached by the module loader.
            void import("../hotkeys/contextActions").then(({ executeNewWorkspace }) => {
              executeNewWorkspace(target.id);
            });
            return;
          }
          default:
            return;
        }
      };

      run(action);
    };

    // Track Cmd/Ctrl key hold for visual shortcut hints.
    // Uses a 500ms delay so quick taps (Cmd+C, Cmd+Tab) never flash hints —
    // only a deliberate hold shows them.
    let metaHoldTimer: ReturnType<typeof setTimeout> | null = null;

    const clearMetaHold = () => {
      if (metaHoldTimer !== null) {
        clearTimeout(metaHoldTimer);
        metaHoldTimer = null;
      }
      useAppStore.getState().setMetaKeyHeld(false);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") clearMetaHold();
    };
    const handleKeyDownMeta = (e: KeyboardEvent) => {
      if ((e.key === "Meta" || e.key === "Control") && !e.repeat) {
        // Start delayed reveal only when Cmd/Ctrl is pressed alone.
        if (!e.shiftKey && !e.altKey && metaHoldTimer === null) {
          metaHoldTimer = setTimeout(() => {
            metaHoldTimer = null;
            useAppStore.getState().setMetaKeyHeld(true);
          }, 500);
        }
      } else {
        // Any other key pressed — cancel pending reveal and hide badges.
        clearMetaHold();
      }
    };
    const handleBlur = () => clearMetaHold();

    window.addEventListener("keydown", handler);
    window.addEventListener("keydown", handleKeyDownMeta);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      clearMetaHold();
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keydown", handleKeyDownMeta);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    toggleSidebar,
    toggleRightSidebar,
    toggleTerminalPanel,
    toggleFuzzyFinder,
    toggleCommandPalette,
    openCommandPaletteFileMode,
    openModal,
    closeModal,
    activeModal,
    fuzzyFinderOpen,
    commandPaletteOpen,
    setDiffSelectedFile,
    diffSelectedFile,
    selectedWorkspaceId,
    activeSessionId,
    setPlanMode,
    planMode,
    chatSearchOpen,
    openChatSearch,
    closeChatSearch,
  ]);
}
