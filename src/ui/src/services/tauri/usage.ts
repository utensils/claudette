import { invoke } from "@tauri-apps/api/core";
import type { ClaudeCodeUsage, UsageSnapshot } from "../../types/usage";
import type { AgentBackendConfig } from "./agentBackends";

export function getClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  return invoke("get_claude_code_usage");
}

/** Per-session usage snapshot. Backend chooses the data source based on
 *  the active backend kind and the user's experimental-flag preference;
 *  see `src-tauri/src/commands/usage.rs::get_session_usage`. */
export function getSessionUsage(args: {
  workspaceId: string;
  chatSessionId: string;
  backend: AgentBackendConfig;
  usageInsightsEnabled: boolean;
  openrouterApiKey?: string | null;
}): Promise<UsageSnapshot> {
  return invoke("get_session_usage", {
    workspaceId: args.workspaceId,
    chatSessionId: args.chatSessionId,
    backend: args.backend,
    usageInsightsEnabled: args.usageInsightsEnabled,
    openrouterApiKey: args.openrouterApiKey ?? null,
  });
}

export function openUsageSettings(): Promise<void> {
  return invoke("open_usage_settings");
}

export function openReleaseNotes(): Promise<void> {
  return invoke("open_release_notes");
}
