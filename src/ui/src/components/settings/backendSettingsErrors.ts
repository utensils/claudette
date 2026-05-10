import type { AgentBackendConfig } from "../../services/tauri";

function backendBaseUrl(backend: AgentBackendConfig): string | null {
  if (backend.kind === "codex_subscription") return null;
  if (backend.base_url?.trim()) return backend.base_url.trim();
  if (backend.kind === "ollama") return "http://localhost:11434";
  if (backend.kind === "openai_api") return "https://api.openai.com";
  if (backend.kind === "lm_studio") return "http://localhost:1234";
  return null;
}

export function formatBackendError(error: unknown, backend: AgentBackendConfig): string {
  const message = String(error).replace(/^Error:\s*/, "").trim();
  const lower = message.toLowerCase();
  const baseUrl = backendBaseUrl(backend);
  if (
    lower.includes("error sending request for url") ||
    lower.includes("connection refused") ||
    lower.includes("failed to query ollama") ||
    lower.includes("failed to query lm studio")
  ) {
    if (backend.kind === "lm_studio") {
      return baseUrl
        ? `LM Studio is not reachable at ${baseUrl}. Run \`lms server start\` or update the Base URL.`
        : "LM Studio is not reachable. Run `lms server start` and try again.";
    }
    return baseUrl
      ? `${backend.label} is not reachable at ${baseUrl}. Start the service or update the Base URL.`
      : `${backend.label} is not reachable. Check the provider and try again.`;
  }
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("authenticated")) {
    return message;
  }
  return message || `${backend.label} request failed.`;
}
