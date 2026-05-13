import type { ChatMessage } from "../types/chat";
import type { SetupResult } from "../types/repository";

/** State of a setup-script run. `running` is the in-flight indicator (rendered
 *  straight from the `runningSetupScripts` store field, not a chat message);
 *  the rest are terminal and reconstructed from the result `System` message.
 *  `output` is the combined stdout/stderr (empty while `running`, and often
 *  empty for a `completed` run that printed nothing). */
export type SetupScriptStatus = "running" | "completed" | "failed" | "timed-out";

export interface SetupScriptOutcome {
  /** `.claudette.json` (repo config) or `settings` (repo-level setting), or
   *  `null` for the catch-path message which doesn't carry a source. */
  source: string | null;
  status: SetupScriptStatus;
  output: string;
}

/** Where a setup script came from: `"repo"` is `.claudette.json` (committed
 *  repo config), `"settings"` is the repo-level setting in Claudette. */
export type SetupScriptSource = "repo" | "settings";

/** The user-facing label embedded in the message content / running banner.
 *  Kept here so the builders, the parser, and the running banner all agree on
 *  exactly one spelling. */
function sourceLabel(source: string): string {
  return source === "repo" ? ".claudette.json" : "settings";
}

/** Build the `System` message content string for a finished setup run. This
 *  is the canonical place the wire format lives — `parseSetupScriptMessage`
 *  is its inverse, and `MessagesWithTurns` renders off the parsed shape. */
export function buildSetupScriptContent(sr: SetupResult): string {
  const label = sourceLabel(sr.source);
  const status = sr.success ? "completed" : sr.timed_out ? "timed out" : "failed";
  return `Setup script (${label}) ${status}${sr.output ? `:\n${sr.output}` : ""}`;
}

/** Build the content string for the catch path (the run threw before it
 *  could report a structured result). */
export function buildSetupScriptErrorContent(err: unknown): string {
  return `Setup script failed: ${err}`;
}

const SETUP_RE = /^Setup script \((.+?)\) (completed|failed|timed out)(?::\n([\s\S]*))?$/;
const ERROR_RE = /^Setup script failed: ([\s\S]*)$/;

/** Parse a setup-script result `System` message back into structured form
 *  (only the terminal states — `running` is never a message). Returns `null`
 *  for any content that isn't one of these shapes, so callers can fall through
 *  to generic message rendering. */
export function parseSetupScriptMessage(content: string): SetupScriptOutcome | null {
  const m = SETUP_RE.exec(content);
  if (m) {
    const raw = m[2];
    const status: SetupScriptStatus = raw === "timed out" ? "timed-out" : (raw as SetupScriptStatus);
    return { source: m[1], status, output: m[3] ?? "" };
  }
  const e = ERROR_RE.exec(content);
  if (e) {
    return { source: null, status: "failed", output: e[1] };
  }
  return null;
}

function blankSystemMessage(
  sessionId: string,
  workspaceId: string,
  content: string,
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    chat_session_id: sessionId,
    role: "System",
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

/** Store hooks the recorder needs. Passed in rather than importing the store
 *  here so this module stays a leaf (`parse`/`build` are pure and trivially
 *  testable; no Zustand wiring pulled into util tests). */
export interface SetupScriptRecorderDeps {
  addChatMessage: (
    sessionId: string,
    message: ChatMessage,
    options?: { persisted?: boolean },
  ) => void;
  /** `setRunningSetupScript` from the chat slice — flag the session as having a
   *  setup script in flight (value = source label), or `null` to clear. */
  setRunningSetupScript: (sessionId: string, source: string | null) => void;
  addToast: (message: string) => void;
  /** Display name of the workspace, for the failure toast. */
  workspaceName?: string | null;
}

function failureToast(deps: SetupScriptRecorderDeps): void {
  const where = deps.workspaceName ? `“${deps.workspaceName}”` : "this workspace";
  deps.addToast(`Setup script for ${where} failed — see the transcript`);
}

/**
 * Mark the session as "setup script running" (so ChatPanel shows the spinner
 * banner), kick off `run()` (typically `() => runWorkspaceSetup(workspaceId)`),
 * and when it settles clear that flag and append the result `System` message —
 * or the catch-path error message, or nothing if no script actually ran. A
 * failed or timed-out run also raises a one-time toast. Fire-and-forget:
 * callers don't await. Shared by all four sites that start a setup script
 * (workspace creation, the sidebar, the command palette, and the confirm-setup
 * modal).
 *
 * The running state is kept in a dedicated store field, *not* a chat message,
 * because the post-creation chat-history reload replaces `chatMessages`
 * wholesale and would wipe an in-flight placeholder. The result message is
 * appended client-only (`persisted: false`) — setup-script messages aren't
 * written to the DB, so they must not bump pagination counts.
 */
export function runAndRecordSetupScript(opts: {
  sessionId: string;
  workspaceId: string;
  source: SetupScriptSource;
  run: () => Promise<SetupResult | null>;
  deps: SetupScriptRecorderDeps;
}): void {
  const { sessionId, workspaceId, source, run, deps } = opts;
  // Store the user-facing label, not the raw source, so the running banner
  // reads `(.claudette.json)` / `(settings)` — matching the completed entry,
  // which `buildSetupScriptContent` writes with the same `sourceLabel`.
  deps.setRunningSetupScript(sessionId, sourceLabel(source));
  run()
    .then((sr) => {
      deps.setRunningSetupScript(sessionId, null);
      if (!sr) return;
      deps.addChatMessage(
        sessionId,
        blankSystemMessage(sessionId, workspaceId, buildSetupScriptContent(sr)),
        { persisted: false },
      );
      if (!sr.success) failureToast(deps);
    })
    .catch((err) => {
      deps.setRunningSetupScript(sessionId, null);
      deps.addChatMessage(
        sessionId,
        blankSystemMessage(sessionId, workspaceId, buildSetupScriptErrorContent(err)),
        { persisted: false },
      );
      failureToast(deps);
    });
}
