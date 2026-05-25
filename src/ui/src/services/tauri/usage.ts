import { invoke } from "@tauri-apps/api/core";
import type { ClaudeCodeUsage, UsageSnapshot } from "../../types/usage";
import type { AgentBackendConfig } from "./agentBackends";

export function getClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  return invoke("get_claude_code_usage");
}

/** Per-session usage snapshot. Backend chooses the data source based on
 *  the active backend kind;
 *  see `src-tauri/src/commands/usage.rs::get_session_usage`. Any secret
 *  the dispatcher needs to call provider usage endpoints (e.g.
 *  OpenRouter `/credits`) is loaded server-side — the frontend never
 *  holds it. */
export function getSessionUsage(args: {
  workspaceId: string;
  chatSessionId: string;
  backend: AgentBackendConfig;
}): Promise<UsageSnapshot> {
  return invoke("get_session_usage", {
    workspaceId: args.workspaceId,
    chatSessionId: args.chatSessionId,
    backend: args.backend,
  });
}

/** Fire a one-shot Codex `account/rateLimits/read` against a freshly
 *  spawned app-server session. The backend writes the result into
 *  `AppState.codex_rate_limits` and mirrors it to SQLite, so the very
 *  next `get_session_usage` call returns live plan quotas instead of
 *  falling back to local-aggregate. Idempotent and best-effort —
 *  always resolves `void`, regardless of auth / spawn / RPC outcome.
 *  See `src-tauri/src/commands/usage.rs::prefetch_codex_rate_limits`. */
export function prefetchCodexRateLimits(backend: AgentBackendConfig): Promise<void> {
  return invoke("prefetch_codex_rate_limits", { backend });
}

export function openUsageSettings(): Promise<void> {
  return invoke("open_usage_settings");
}

export function openReleaseNotes(): Promise<void> {
  return invoke("open_release_notes");
}
