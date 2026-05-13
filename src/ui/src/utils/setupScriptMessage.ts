import type { ChatMessage } from "../types/chat";
import type { SetupResult } from "../types/repository";

/** Outcome of a setup-script run, reconstructed from the `System` chat
 *  message the run is persisted as. `output` is the combined stdout/stderr
 *  the script produced (possibly empty). */
export type SetupScriptStatus = "completed" | "failed" | "timed-out";

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

const COMPLETED_RE = /^Setup script \((.+?)\) (completed|failed|timed out)(?::\n([\s\S]*))?$/;
const ERROR_RE = /^Setup script failed: ([\s\S]*)$/;

/** Parse a setup-script `System` message back into structured form. Returns
 *  `null` for any content that isn't one of the two setup-script shapes, so
 *  callers can fall through to generic message rendering. */
export function parseSetupScriptMessage(content: string): SetupScriptOutcome | null {
  const m = COMPLETED_RE.exec(content);
  if (m) {
    const status: SetupScriptStatus = m[2] === "timed out" ? "timed-out" : (m[2] as SetupScriptStatus);
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
 *  here so this module stays a leaf (parse/build are pure and trivially
 *  testable; no Zustand wiring pulled into util tests). */
export interface SetupScriptRecorderDeps {
  addChatMessage: (sessionId: string, message: ChatMessage) => void;
  addToast: (message: string) => void;
  /** Display name of the workspace, for the failure toast. */
  workspaceName?: string | null;
}

function failureToast(deps: SetupScriptRecorderDeps): void {
  const where = deps.workspaceName ? `“${deps.workspaceName}”` : "this workspace";
  deps.addToast(`Setup script for ${where} failed — see the transcript`);
}

/** Append the `System` message for a finished setup run to its chat session,
 *  and — if the run failed or timed out — raise a one-time toast so the
 *  failure isn't missed when it scrolls past in the transcript. Shared by all
 *  four sites that kick off a setup script (workspace creation, the sidebar,
 *  the command palette, and the confirm-setup modal). */
export function recordSetupScriptResult(
  sessionId: string,
  workspaceId: string,
  sr: SetupResult,
  deps: SetupScriptRecorderDeps,
): void {
  deps.addChatMessage(sessionId, blankSystemMessage(sessionId, workspaceId, buildSetupScriptContent(sr)));
  if (!sr.success) failureToast(deps);
}

/** Append the catch-path `System` message (the run threw) and raise the
 *  failure toast. */
export function recordSetupScriptError(
  sessionId: string,
  workspaceId: string,
  err: unknown,
  deps: SetupScriptRecorderDeps,
): void {
  deps.addChatMessage(sessionId, blankSystemMessage(sessionId, workspaceId, buildSetupScriptErrorContent(err)));
  failureToast(deps);
}
