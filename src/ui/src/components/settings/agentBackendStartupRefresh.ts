import type { AgentBackendConfig } from "../../services/tauri";

export function shouldShowBackendTestButton(backend: AgentBackendConfig) {
  return backend.kind !== "codex_native";
}

export function startupRefreshBackendIds(backends: AgentBackendConfig[]) {
  return backends
    .filter((backend) => backend.enabled && backend.kind === "codex_native")
    .map((backend) => backend.id);
}

export async function refreshStartupCodexBackends({
  backends,
  refreshBackend,
  onBackends,
  onError,
}: {
  backends: AgentBackendConfig[];
  refreshBackend: (backendId: string) => Promise<AgentBackendConfig[]>;
  onBackends: (backends: AgentBackendConfig[]) => void;
  onError: (backendId: string, error: unknown) => void;
}) {
  for (const backendId of startupRefreshBackendIds(backends)) {
    try {
      const refreshed = await refreshBackend(backendId);
      onBackends(refreshed);
    } catch (error) {
      onError(backendId, error);
    }
  }
}
