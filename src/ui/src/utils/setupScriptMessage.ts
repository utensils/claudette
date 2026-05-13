import type { ChatMessage } from "../types/chat";
import type { SetupResult } from "../types/repository";

/** State of a setup-script run, reconstructed from the `System` chat message
 *  it's represented by. `running` is the in-flight placeholder; the rest are
 *  terminal. `output` is the combined stdout/stderr (empty while `running`,
 *  and often empty for a `completed` run that printed nothing). */
export type SetupScriptStatus = "running" | "completed" | "failed" | "timed-out";

export interface SetupScriptOutcome {
  /** `.claudette.json` (repo config) or `settings` (repo-level setting), or
   *  `null` for the catch-path message which doesn't carry a source. */
  source: string | null;
  status: SetupScriptStatus;
  output: string;
}

/** The user-facing label embedded in the message content. Kept here so the
 *  builders and the parser agree on exactly one spelling. */
function sourceLabel(source: string): string {
  return source === "repo" ? ".claudette.json" : "settings";
}

/** Content for the in-flight placeholder, posted before the script is spawned
 *  and swapped in place once it finishes. `source` is the frontend's guess
 *  (`"repo"` / `"settings"`); the result message uses the authoritative
 *  `SetupResult.source`. */
export function buildSetupScriptRunningContent(source: string): string {
  return `Setup script (${sourceLabel(source)}) running`;
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

const SETUP_RE = /^Setup script \((.+?)\) (completed|failed|timed out|running)(?::\n([\s\S]*))?$/;
const ERROR_RE = /^Setup script failed: ([\s\S]*)$/;

/** Parse a setup-script `System` message back into structured form. Returns
 *  `null` for any content that isn't one of these shapes, so callers can fall
 *  through to generic message rendering. */
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
  id: string,
): ChatMessage {
  return {
    id,
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
  updateChatMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
  ) => void;
  removeChatMessage: (sessionId: string, messageId: string) => void;
  addToast: (message: string) => void;
  /** Display name of the workspace, for the failure toast. */
  workspaceName?: string | null;
}

function failureToast(deps: SetupScriptRecorderDeps): void {
  const where = deps.workspaceName ? `“${deps.workspaceName}”` : "this workspace";
  deps.addToast(`Setup script for ${where} failed — see the transcript`);
}

/**
 * Post a "Setup script (…) running" placeholder to the chat session, kick off
 * `run()` (typically `() => runWorkspaceSetup(workspaceId)`), and when it
 * settles swap the placeholder *in place* for the result message — or the
 * catch-path error, or simply remove it if nothing actually ran. A failed or
 * timed-out run also raises a one-time toast. Fire-and-forget: callers don't
 * await. Shared by all four sites that start a setup script (workspace
 * creation, the sidebar, the command palette, and the confirm-setup modal).
 *
 * The placeholder is client-only (`persisted: false`) — setup-script messages
 * aren't written to the DB, and the placeholder must not bump pagination
 * counts.
 */
export function runAndRecordSetupScript(opts: {
  sessionId: string;
  workspaceId: string;
  /** `"repo"` (`.claudette.json`) or `"settings"` — drives the placeholder label. */
  source: string;
  run: () => Promise<SetupResult | null>;
  deps: SetupScriptRecorderDeps;
}): void {
  const { sessionId, workspaceId, source, run, deps } = opts;
  const placeholderId = crypto.randomUUID();
  deps.addChatMessage(
    sessionId,
    blankSystemMessage(sessionId, workspaceId, buildSetupScriptRunningContent(source), placeholderId),
    { persisted: false },
  );
  run()
    .then((sr) => {
      if (!sr) {
        // No script actually resolved on the backend — drop the placeholder.
        deps.removeChatMessage(sessionId, placeholderId);
        return;
      }
      deps.updateChatMessage(sessionId, placeholderId, {
        content: buildSetupScriptContent(sr),
      });
      if (!sr.success) failureToast(deps);
    })
    .catch((err) => {
      deps.updateChatMessage(sessionId, placeholderId, {
        content: buildSetupScriptErrorContent(err),
      });
      failureToast(deps);
    });
}
