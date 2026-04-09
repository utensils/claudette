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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

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
  ]);
}
