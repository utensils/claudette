import { describe, expect, it } from "vitest";
import type { AgentBackendConfig } from "../../services/tauri";
import { formatBackendError } from "./backendSettingsErrors";

function backend(overrides: Partial<AgentBackendConfig> = {}): AgentBackendConfig {
  return {
    id: "ollama",
    label: "Ollama",
    kind: "ollama",
    base_url: "http://localhost:11434",
    enabled: true,
    default_model: null,
    manual_models: [],
    discovered_models: [],
    auth_ref: null,
    capabilities: {
      thinking: false,
      effort: false,
      fast_mode: false,
      one_m_context: false,
      tools: true,
      vision: false,
    },
    context_window_default: 64_000,
    model_discovery: true,
    has_secret: false,
    ...overrides,
  };
}

describe("formatBackendError", () => {
  it("turns raw unreachable Ollama transport failures into an actionable local error", () => {
    const message = formatBackendError(
      "Failed to query Ollama: error sending request for url (http://localhost:11434/api/tags)",
      backend(),
    );

    expect(message).toBe(
      "Ollama is not reachable at http://localhost:11434. Start the service or update the Base URL.",
    );
  });

  it("preserves authentication errors without hiding the action", () => {
    const message = formatBackendError(
      "OpenAI API backend requires an API key in Settings -> Models",
      backend({ id: "openai-api", label: "OpenAI API", kind: "openai_api" }),
    );

    expect(message).toBe("OpenAI API backend requires an API key in Settings -> Models");
  });
});
