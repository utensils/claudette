import { invoke } from "@tauri-apps/api/core";

export type ClaudeRemoteControlLifecycle =
  | "disabled"
  | "enabling"
  | "ready"
  | "connected"
  | "reconnecting"
  | "error";

export interface ClaudeRemoteControlStatus {
  state: ClaudeRemoteControlLifecycle;
  sessionUrl: string | null;
  connectUrl: string | null;
  environmentId: string | null;
  detail: string | null;
  lastError: string | null;
}

export function getClaudeRemoteControlStatus(
  chatSessionId: string,
): Promise<ClaudeRemoteControlStatus> {
  return invoke("get_claude_remote_control_status", { chatSessionId });
}

export function setClaudeRemoteControl(
  chatSessionId: string,
  enabled: boolean,
  options: {
    permissionLevel?: string;
    model?: string;
    fastMode?: boolean;
    thinkingEnabled?: boolean;
    planMode?: boolean;
    effort?: string | null;
    chromeEnabled?: boolean;
    disable1mContext?: boolean;
    backendId?: string;
  } = {},
): Promise<ClaudeRemoteControlStatus> {
  return invoke("set_claude_remote_control", {
    chatSessionId,
    enabled,
    permissionLevel: options.permissionLevel ?? null,
    model: options.model ?? null,
    fastMode: options.fastMode ?? null,
    thinkingEnabled: options.thinkingEnabled ?? null,
    planMode: options.planMode ?? null,
    effort: options.effort ?? null,
    chromeEnabled: options.chromeEnabled ?? null,
    disable1mContext: options.disable1mContext ?? null,
    backendId: options.backendId ?? null,
  });
}
