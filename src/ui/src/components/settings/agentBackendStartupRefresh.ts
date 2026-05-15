import type { AgentBackendConfig, AgentBackendListResponse } from "../../services/tauri";

export function shouldShowBackendTestButton(backend: AgentBackendConfig) {
  return backend.kind !== "codex_native";
}

export function autoDetectableBackendIds(backends: AgentBackendConfig[]) {
  // Pi is intentionally excluded: the Tauri `auto_detect_agent_backends`
  // command only probes Codex, Ollama, and LM Studio, so listing Pi here
  // promised an auto-refresh on startup that never actually happens. Pi
  // model discovery remains available via the explicit Refresh models /
  // Test backend actions.
  return backends
    .filter((backend) =>
      backend.kind === "codex_native" ||
      backend.kind === "ollama" ||
      backend.kind === "lm_studio"
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
