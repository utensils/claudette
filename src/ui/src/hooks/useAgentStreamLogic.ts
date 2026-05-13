// Pure helper extracted from useAgentStream's `case "system"` branch so
// the first-emit-wins / persist semantics for `command_line` events can
// be tested without rendering the hook.

import type { ContentBlock } from "../types/agent-events";

export interface CommandLineEvent {
  subtype: string;
  command_line?: string | null;
}

export interface CommandLineApplyDeps {
  /// Returns the session's currently-stored cli_invocation, or null if
  /// none is recorded yet.
  getCurrent: (sessionId: string) => string | null;
  /// Update the session record in the store with the new invocation.
  updateSession: (sessionId: string, line: string) => void;
  /// Persist via the Tauri command. Errors logged + dropped (banner is
  /// UX-cosmetic).
  persist: (sessionId: string, line: string) => Promise<void>;
}

/// Returns true iff the event was a `command_line` event AND triggered
/// (or short-circuited) one of the apply branches. Returns false when
/// the event isn't a `command_line` event at all (so the caller can
/// fall through to other System subtypes).
export function applyCommandLineEvent(
  event: CommandLineEvent,
  sessionId: string,
  deps: CommandLineApplyDeps,
): boolean {
  if (event.subtype !== "command_line") return false;
  if (typeof event.command_line !== "string") return false;
  const line = event.command_line;
  // First-emit-wins: don't overwrite a captured invocation with a later
  // respawn's argv.
  const current = deps.getCurrent(sessionId);
  if (current !== null && current !== "") return true;
  deps.updateSession(sessionId, line);
  void deps.persist(sessionId, line).catch((e) => {
    console.warn("[stream] persist cli_invocation failed:", e);
  });
  return true;
}

export function extractAssistantMessageParts(content: ContentBlock[]): {
  text: string;
  thinking: string;
} {
  return content.reduce(
    (parts, block) => {
      if (block.type === "text") {
        parts.text += block.text;
      } else if (block.type === "thinking") {
        parts.thinking += block.thinking;
      }
      return parts;
    },
    { text: "", thinking: "" },
  );
}
