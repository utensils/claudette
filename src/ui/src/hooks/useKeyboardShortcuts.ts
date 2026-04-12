import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { stopAgent, sendRemoteCommand } from "../services/tauri";

export function useKeyboardShortcuts() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleFuzzyFinder = useAppStore((s) => s.toggleFuzzyFinder);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const closeModal = useAppStore((s) => s.closeModal);
  const activeModal = useAppStore((s) => s.activeModal);
  const fuzzyFinderOpen = useAppStore((s) => s.fuzzyFinderOpen);
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const planMode = useAppStore(
    (s) => (selectedWorkspaceId ? s.planMode[selectedWorkspaceId] ?? false : false),
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Shift+Tab: toggle plan mode — only when no overlay is open and no
      // interactive element (input, textarea, select, button) is focused,
      // so it doesn't break standard focus navigation.
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isInteractive = activeTag === "input" || activeTag === "textarea" ||
        activeTag === "select" || activeTag === "button";
      if (
        e.key === "Tab" && e.shiftKey && !mod && selectedWorkspaceId &&
        !activeModal && !commandPaletteOpen && !fuzzyFinderOpen && !isInteractive
      ) {
        e.preventDefault();
        setPlanMode(selectedWorkspaceId, !planMode);
        return;
      }

      // Escape: dismiss topmost overlay, or stop running agent
      if (e.key === "Escape") {
        if (commandPaletteOpen) {
          toggleCommandPalette();
        } else if (activeModal) {
          closeModal();
        } else if (useAppStore.getState().settingsOpen) {
          useAppStore.getState().closeSettings();
        } else if (fuzzyFinderOpen) {
          toggleFuzzyFinder();
        } else if (diffSelectedFile) {
          setDiffSelectedFile(null);
        } else if (selectedWorkspaceId) {
          // Stop agent if running (lowest priority, after all overlays)
          const ws = useAppStore.getState().workspaces.find(
            (w) => w.id === selectedWorkspaceId,
          );
          if (ws?.agent_status === "Running") {
            // Clear queued message — user is taking manual control.
            useAppStore.getState().clearQueuedMessage(selectedWorkspaceId);
            // Route through remote or local stop path.
            const stopPromise = ws.remote_connection_id
              ? sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
                  workspace_id: selectedWorkspaceId,
                })
              : stopAgent(selectedWorkspaceId);
            stopPromise.catch(console.error);
            useAppStore.getState().updateWorkspace(selectedWorkspaceId, {
              agent_status: "Stopped",
            });
          }
        }
        return;
      }

      if (!mod) return;

      // Cmd/Ctrl+Shift+[ or ]: cycle workspaces in current project
      if (e.shiftKey && (e.key === "[" || e.key === "]") && selectedWorkspaceId) {
        e.preventDefault();
        const state = useAppStore.getState();
        const currentWs = state.workspaces.find((w) => w.id === selectedWorkspaceId);
        if (currentWs) {
          const siblings = state.workspaces.filter(
            (w) => w.repository_id === currentWs.repository_id && w.status === "Active",
          );
          if (siblings.length > 1) {
            const idx = siblings.findIndex((w) => w.id === selectedWorkspaceId);
            const next = e.key === "]"
              ? siblings[(idx + 1) % siblings.length]
              : siblings[(idx - 1 + siblings.length) % siblings.length];
            state.selectWorkspace(next.id);
          }
        }
        return;
      }

      // Cmd/Ctrl+1-9: jump to project by index
      if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
        e.preventDefault();
        const state = useAppStore.getState();
        const localRepos = state.repositories.filter((r) => !r.remote_connection_id);
        const idx = parseInt(e.key, 10) - 1;
        if (idx < localRepos.length) {
          const repo = localRepos[idx];
          // Select first active workspace for this repo
          const ws = state.workspaces.find(
            (w) => w.repository_id === repo.id && w.status === "Active",
          );
          if (ws) state.selectWorkspace(ws.id);
        }
        return;
      }

      switch (e.key) {
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "k":
          e.preventDefault();
          toggleFuzzyFinder();
          break;
        case "p":
          e.preventDefault();
          toggleCommandPalette();
          break;
        case "d":
          e.preventDefault();
          toggleRightSidebar();
          break;
        case "`":
          e.preventDefault();
          toggleTerminalPanel();
          break;
        case ",":
          e.preventDefault();
          {
            const store = useAppStore.getState();
            if (store.settingsOpen) {
              store.closeSettings();
            } else {
              store.openSettings();
            }
          }
          break;
      }
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
    closeModal,
    activeModal,
    fuzzyFinderOpen,
    commandPaletteOpen,
    setDiffSelectedFile,
    diffSelectedFile,
    selectedWorkspaceId,
    setPlanMode,
    planMode,
  ]);
}
