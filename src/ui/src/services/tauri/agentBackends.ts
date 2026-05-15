import { invoke } from "@tauri-apps/api/core";

export type AgentBackendKind =
  | "anthropic"
  | "ollama"
  | "openai_api"
  | "codex_subscription"
  | "codex_native"
  | "custom_anthropic"
  | "custom_openai"
  | "lm_studio";

export interface AgentBackendCapabilities {
  thinking: boolean;
  effort: boolean;
  fast_mode: boolean;
  one_m_context: boolean;
  tools: boolean;
  vision: boolean;
}

export interface AgentBackendModel {
  id: string;
  label: string;
  context_window_tokens: number;
  discovered: boolean;
}

export interface AgentBackendConfig {
  id: string;
  label: string;
  kind: AgentBackendKind;
  base_url: string | null;
  enabled: boolean;
  default_model: string | null;
  manual_models: AgentBackendModel[];
  discovered_models: AgentBackendModel[];
  auth_ref: string | null;
  capabilities: AgentBackendCapabilities;
  context_window_default: number;
  model_discovery: boolean;
  has_secret: boolean;
}

export interface AgentBackendListResponse {
  backends: AgentBackendConfig[];
  default_backend_id: string;
  /**
   * Non-fatal diagnostics from the tolerant loader — e.g. a stored
   * backend entry whose `kind` isn't recognized by this build. The
   * entries are preserved in SQLite (so they round-trip through
   * downgrades), but the user should know they aren't active.
   * Omitted from the wire payload (i.e. `undefined` here) when
   * everything parsed cleanly — the Rust side uses
   * `skip_serializing_if = "Vec::is_empty"`, so consumers should
   * treat `undefined` and `[]` identically.
   */
  warnings?: string[];
}

export interface BackendSecretUpdate {
  backend_id: string;
  value: string | null;
}

export interface BackendStatus {
  ok: boolean;
  message: string;
  backends?: AgentBackendConfig[];
}

export function listAgentBackends(): Promise<AgentBackendListResponse> {
  return invoke("list_agent_backends");
}

export function autoDetectAgentBackends(): Promise<AgentBackendListResponse> {
  return invoke("auto_detect_agent_backends");
}

export function saveAgentBackend(
  backend: AgentBackendConfig,
): Promise<AgentBackendConfig[]> {
  return invoke("save_agent_backend", { backend });
}

export function deleteAgentBackend(
  backendId: string,
): Promise<AgentBackendConfig[]> {
  return invoke("delete_agent_backend", { backendId });
}

export function saveAgentBackendSecret(
  update: BackendSecretUpdate,
): Promise<void> {
  return invoke("save_agent_backend_secret", { update });
}

export function refreshAgentBackendModels(
  backendId: string,
): Promise<AgentBackendConfig[]> {
  return invoke("refresh_agent_backend_models", { backendId });
}

export function testAgentBackend(backendId: string): Promise<BackendStatus> {
  return invoke("test_agent_backend", { backendId });
}

export function launchCodexLogin(): Promise<void> {
  return invoke("launch_codex_login");
}
