import type { AgentBackendConfig, AgentBackendListResponse } from "../../services/tauri";

export function shouldShowBackendTestButton(backend: AgentBackendConfig) {
  return backend.kind !== "codex_native";
}

export function autoDetectableBackendIds(backends: AgentBackendConfig[]) {
  // Pi is included because the Tauri `auto_detect_agent_backends`
  // command now probes Pi alongside Codex/Ollama/LM Studio via the
  // shared model-discovery probe. Without Pi here, a fresh launch
  // would leave the chat-header model picker showing only the two
  // seed manual models until the user manually clicked Refresh.
  return backends
    .filter((backend) =>
      backend.kind === "codex_native" ||
      backend.kind === "ollama" ||
      backend.kind === "lm_studio" ||
      backend.kind === "pi_sdk"
    )
    .map((backend) => backend.id);
}

export async function autoDetectStartupAgentBackends({
  backends,
  autoDetectBackends,
  onBackends,
  onDefaultBackend,
  onError,
}: {
  backends: AgentBackendConfig[];
  autoDetectBackends: () => Promise<AgentBackendListResponse>;
  onBackends: (backends: AgentBackendConfig[]) => void;
  onDefaultBackend: (backendId: string) => void;
  onError: (error: unknown) => void;
}) {
  if (autoDetectableBackendIds(backends).length === 0) return;
  try {
    const detected = await autoDetectBackends();
    onBackends(detected.backends);
    onDefaultBackend(detected.default_backend_id);
  } catch (error) {
    onError(error);
  }
}
