import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";

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

      // Shift+Tab: toggle plan mode — only when no overlay/modal is open
      // so it doesn't break form tab navigation in modals
      if (
        e.key === "Tab" && e.shiftKey && !mod && selectedWorkspaceId &&
        !activeModal && !commandPaletteOpen && !fuzzyFinderOpen
      ) {
        e.preventDefault();
        setPlanMode(selectedWorkspaceId, !planMode);
        return;
      }

      // Escape: dismiss topmost overlay
      if (e.key === "Escape") {
        if (commandPaletteOpen) {
          toggleCommandPalette();
        } else if (activeModal) {
          closeModal();
        } else if (fuzzyFinderOpen) {
          toggleFuzzyFinder();
        } else if (diffSelectedFile) {
          setDiffSelectedFile(null);
        }
        return;
      }

      if (!mod) return;

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
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
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
