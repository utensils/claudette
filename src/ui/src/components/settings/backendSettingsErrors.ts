import i18n from "../../i18n";
import type { AgentBackendConfig } from "../../services/tauri";

function backendBaseUrl(backend: AgentBackendConfig): string | null {
  if (
    backend.kind === "codex_subscription" ||
    backend.kind === "codex_native" ||
    backend.kind === "antigravity"
  ) {
    return null;
  }
  if (backend.base_url?.trim()) return backend.base_url.trim();
  if (backend.kind === "ollama") return "http://localhost:11434";
  if (backend.kind === "openai_api") return "https://api.openai.com";
  return null;
}

export function formatBackendError(error: unknown, backend: AgentBackendConfig): string {
  const message = String(error).replace(/^Error:\s*/, "").trim();
  const lower = message.toLowerCase();
  const baseUrl = backendBaseUrl(backend);
  if (
    lower.includes("error sending request for url") ||
    lower.includes("connection refused") ||
    lower.includes("failed to query ollama")
  ) {
    return baseUrl
      ? i18n.t("settings:backend_error_unreachable_at", { label: backend.label, url: baseUrl })
      : i18n.t("settings:backend_error_unreachable", { label: backend.label });
  }
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("authenticated")) {
    return message;
  }
  return message || i18n.t("settings:backend_error_request_failed", { label: backend.label });
}
