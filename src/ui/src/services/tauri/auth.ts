import { invoke } from "@tauri-apps/api/core";

export interface ClaudeAuthStatus {
  state: "signed_in" | "signed_out" | "unknown";
  loggedIn: boolean;
  verified: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  message: string | null;
}

export function getClaudeAuthStatus(
  validate = false,
  options: { quiet?: boolean } = {},
): Promise<ClaudeAuthStatus> {
  return invoke("get_claude_auth_status", {
    validate,
    quiet: options.quiet ?? false,
  });
}

export function claudeAuthLogin(): Promise<void> {
  return invoke("claude_auth_login");
}

export function submitClaudeAuthCode(code: string): Promise<void> {
  return invoke("submit_claude_auth_code", { code });
}

export function cancelClaudeAuthLogin(): Promise<void> {
  return invoke("cancel_claude_auth_login");
}
