import { invoke } from "@tauri-apps/api/core";

export type AgentBackendKind =
  | "anthropic"
  | "ollama"
  | "openai_api"
  | "codex_subscription"
  | "codex_native"
  | "pi_sdk"
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

/**
 * Which subprocess Claudette spawns for a chat turn on this backend.
 * Mirrors the Rust `AgentBackendRuntimeHarness` enum.
 *
 *  - `claude_code` — the bundled Claude CLI (with `ANTHROPIC_BASE_URL` /
 *    gateway env when the backend isn't Anthropic itself).
 *  - `claude_interactive` — interactive `claude` running inside a
 *    detachable host (tmux on Unix, sidecar on Windows). Gated on the
 *    `claudeInteractiveEnabled` experimental flag and intentionally
 *    absent from `availableHarnessesForKind` — the experimental gate
 *    is enforced server-side via `AgentBackendConfig.effective_harness_kind`.
 *  - `codex_app_server` — the Codex CLI's debug app-server.
 *  - `pi_sdk` — Claudette's bundled Pi sidecar.
 */
export type AgentBackendRuntimeHarness =
  | "claude_code"
  | "claude_interactive"
  | "codex_app_server"
  | "pi_sdk";

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
  /** User override for which runtime harness handles this backend.
   *  `undefined` means use the kind's default — see `defaultHarnessForKind`. */
  runtime_harness?: AgentBackendRuntimeHarness | null;
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

export function launchCodexLogin(workspaceId?: string | null): Promise<void> {
  return invoke("launch_codex_login", { workspaceId: workspaceId ?? null });
}

export function setAgentBackendRuntimeHarness(
  backendId: string,
  harness: AgentBackendRuntimeHarness | null,
): Promise<AgentBackendConfig[]> {
  return invoke("set_agent_backend_runtime_harness", { backendId, harness });
}

/**
 * Mirror of `AgentBackendKind::default_harness` for the frontend.
 * Keep in lockstep with `src/agent_backend.rs` — a Rust-side test
 * pins the matrix.
 */
export function defaultHarnessForKind(
  kind: AgentBackendKind,
): AgentBackendRuntimeHarness {
  switch (kind) {
    case "anthropic":
    case "custom_anthropic":
    case "codex_subscription":
    case "openai_api":
    case "custom_openai":
      return "claude_code";
    case "ollama":
    case "lm_studio":
      return "pi_sdk";
    case "codex_native":
      return "codex_app_server";
    case "pi_sdk":
      return "pi_sdk";
  }
}

/**
 * Mirror of `AgentBackendKind::available_harnesses` /
 * `available_harnesses_with_interactive`. The first entry is the
 * default. Pinning a value outside this list is rejected server-side by
 * `set_agent_backend_runtime_harness`.
 *
 * `"claude_interactive"` is intentionally **not** in the static matrix:
 * it's gated by the `claudeInteractiveEnabled` experimental flag, not
 * the per-kind allow-list. Callers that have the flag value available
 * (the Settings runtime picker, anything driving persistence) should
 * pass it via `options.claudeInteractiveEnabled` so the Claude-flavored
 * kinds (Anthropic, CustomAnthropic, CodexSubscription) gain
 * `"claude_interactive"` as a second option. Other call sites — the
 * Pi-disabled downgrade in `resolveSessionHarness`, the gateway-hash
 * key — want the matrix shape and should call without the option (the
 * flag defaults to `false`).
 */
export function availableHarnessesForKind(
  kind: AgentBackendKind,
  options?: { claudeInteractiveEnabled?: boolean },
): AgentBackendRuntimeHarness[] {
  const base: AgentBackendRuntimeHarness[] = (() => {
    switch (kind) {
      case "anthropic":
      case "custom_anthropic":
      case "codex_subscription":
        return ["claude_code"];
      case "ollama":
      case "lm_studio":
        return ["pi_sdk", "claude_code"];
      case "openai_api":
      case "custom_openai":
        return ["claude_code", "pi_sdk"];
      case "codex_native":
        return ["codex_app_server", "pi_sdk"];
      case "pi_sdk":
        return ["pi_sdk"];
    }
  })();
  if (
    options?.claudeInteractiveEnabled === true &&
    (kind === "anthropic" ||
      kind === "custom_anthropic" ||
      kind === "codex_subscription")
  ) {
    base.push("claude_interactive");
  }
  return base;
}

/** Effective harness for a config: persisted override when allowed,
 *  otherwise the kind's default.
 *
 *  Mirrors the Rust-side `AgentBackendConfig::effective_harness_kind`
 *  (in `src/agent_backend.rs`): the persisted override is honored when
 *  it appears in `availableHarnessesForKind(kind)`, OR when it's
 *  `"claude_interactive"` AND the `claudeInteractiveEnabled`
 *  experimental flag is on. `"claude_interactive"` is intentionally
 *  absent from `availableHarnessesForKind` because the gate is the
 *  experimental flag, not the per-kind matrix — so any caller that
 *  has the flag value must pass it here, otherwise a backend with
 *  `runtime_harness === "claude_interactive"` silently falls back to
 *  the kind's default harness (a frontend/backend state mismatch).
 *
 *  @param backend Persisted backend config.
 *  @param options.claudeInteractiveEnabled Value of the experimental
 *    flag from the Zustand store. Defaults to `false` for callers that
 *    don't (yet) know about the flag — same as the Rust default. */
export function effectiveHarness(
  backend: AgentBackendConfig,
  options?: { claudeInteractiveEnabled?: boolean },
): AgentBackendRuntimeHarness {
  const override = backend.runtime_harness ?? undefined;
  if (
    override === "claude_interactive" &&
    options?.claudeInteractiveEnabled === true
  ) {
    return override;
  }
  if (override && availableHarnessesForKind(backend.kind).includes(override)) {
    return override;
  }
  return defaultHarnessForKind(backend.kind);
}
