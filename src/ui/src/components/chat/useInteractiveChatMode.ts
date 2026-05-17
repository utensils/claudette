// Helper hook that tells ChatPanel whether to short-circuit its
// classic `claude --print` render path and use the interactive
// (tmux/sidecar) render path instead.
//
// Extracted into its own module so ChatPanel — which is on the
// CLAUDE.md god-file list — stays at "one new import, one new
// conditional render" instead of growing another store-reading
// section.

import { useAppStore } from "../../stores/useAppStore";
import {
  effectiveHarness,
  type AgentBackendRuntimeHarness,
} from "../../services/tauri/agentBackends";

export interface InteractiveChatMode {
  /** Which harness the workspace's active backend resolves to via
   *  `effectiveHarness`. Only `"claude_interactive"` triggers the new
   *  render path; every other value means "render the classic chat
   *  panel". Exposed so callers can also gate ChatHeader affordances
   *  ("Open in Terminal" button) on the same value. */
  harness: AgentBackendRuntimeHarness;
  /** True only when `harness === "claude_interactive"`. Pre-computed
   *  here so consumers don't have to remember the magic string. */
  isInteractive: boolean;
  /** Per-workspace toggle: when true, render
   *  `InteractiveTerminalMode` instead of `InteractiveTurns`. Always
   *  `false` for non-interactive harnesses. */
  terminalMode: boolean;
}

/** Read the current chat session's effective backend harness from the
 *  store. Returns the safe "classic" default (`claude_code`) when any
 *  of the lookups miss — that matches the Rust default and means a
 *  store mid-hydration can't accidentally flip the chat view. */
export function useInteractiveChatMode(
  workspaceId: string | null,
  sessionId: string | null,
): InteractiveChatMode {
  const agentBackends = useAppStore((s) => s.agentBackends);
  const defaultAgentBackendId = useAppStore((s) => s.defaultAgentBackendId);
  const selectedModelProvider = useAppStore((s) => s.selectedModelProvider);
  const claudeInteractiveEnabled = useAppStore(
    (s) => s.claudeInteractiveEnabled,
  );
  const terminalModeMap = useAppStore(
    (s) => s.interactiveTerminalModeByWorkspace,
  );

  // Session-scoped provider falls back to the global default (mirrors
  // how chat-send resolves the backend in `ChatPanel`).
  const providerId =
    (sessionId ? selectedModelProvider[sessionId] : null) ??
    defaultAgentBackendId;
  const backend = agentBackends.find((b) => b.id === providerId);

  const harness: AgentBackendRuntimeHarness = backend
    ? effectiveHarness(backend, { claudeInteractiveEnabled })
    : "claude_code";

  const isInteractive = harness === "claude_interactive";
  const terminalMode = isInteractive
    ? Boolean(workspaceId && terminalModeMap[workspaceId])
    : false;

  return { harness, isInteractive, terminalMode };
}
