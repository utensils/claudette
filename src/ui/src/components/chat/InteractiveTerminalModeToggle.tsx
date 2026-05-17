// "Open in Terminal" / "Back to Chat" toggle for the chat header.
//
// Surfaces only when the workspace's active backend resolves to the
// ClaudeInteractive harness and there is an active chat session — i.e.
// exactly the conditions under which ChatPanel renders the new
// interactive views. Clicking flips
// `interactiveTerminalModeByWorkspace[workspaceId]` in the Zustand
// store, which ChatPanel observes via `useInteractiveChatMode`.

import { SquareTerminal, MessageSquare } from "lucide-react";

import { useAppStore } from "../../stores/useAppStore";
import { useInteractiveChatMode } from "./useInteractiveChatMode";
import styles from "./InteractiveTerminalModeToggle.module.css";

export function InteractiveTerminalModeToggle() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? (s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null)
      : null,
  );
  const toggle = useAppStore((s) => s.toggleInteractiveTerminalMode);
  const mode = useInteractiveChatMode(selectedWorkspaceId, activeSessionId);

  // Hide entirely outside the interactive code path so the chat header
  // doesn't grow a misleading button for classic Claude sessions.
  if (!mode.isInteractive || !selectedWorkspaceId || !activeSessionId) {
    return null;
  }

  const label = mode.terminalMode ? "Back to chat" : "Open in terminal";
  const Icon = mode.terminalMode ? MessageSquare : SquareTerminal;

  return (
    <button
      type="button"
      className={`${styles.toggle} ${mode.terminalMode ? styles.active : ""}`}
      onClick={() => toggle(selectedWorkspaceId)}
      aria-pressed={mode.terminalMode}
      aria-label={label}
      title={label}
      data-testid="interactive-terminal-mode-toggle"
    >
      <Icon size={14} />
    </button>
  );
}
