/**
 * Model registry — the canonical list of models the UI exposes.
 *
 * Lives in a non-React module so logic that only needs the metadata
 * (slash command validation, toolbar state normalization) can import it
 * without dragging in component CSS or React deps.
 */
export type Model = {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly extraUsage: boolean;
  readonly legacy?: boolean;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly providerQualifiedId?: string;
  readonly supportsThinking?: boolean;
  readonly supportsEffort?: boolean;
  readonly supportsFastMode?: boolean;
  /** Maximum total tokens this model can hold across input + cache + output.
   *  Used by the ContextMeter to compute utilization as a percentage. */
  readonly contextWindowTokens: number;
};

export function is1mContextModel(modelId: string): boolean {
  const entry = MODELS.find((m) => m.id === modelId);
  return entry ? entry.contextWindowTokens >= 1_000_000 : false;
}

const NON_1M_FALLBACKS: Record<string, string> = {
  "opus": "claude-opus-4-7",
  "claude-sonnet-4-6[1m]": "sonnet",
  "claude-opus-4-6[1m]": "claude-opus-4-6",
};

export function get1mFallback(modelId: string): string {
  return NON_1M_FALLBACKS[modelId] ?? modelId;
}

export const MODELS: readonly Model[] = [
  { id: "opus", label: "Opus 4.7 1M", group: "Claude Code", extraUsage: true, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "sonnet", label: "Sonnet 4.6", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", group: "Claude Code", extraUsage: true, contextWindowTokens: 1_000_000 },
  { id: "haiku", label: "Haiku 4.5", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M", group: "Claude Code", extraUsage: true, legacy: true, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-5", label: "Opus 4.5", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-haiku-3-5", label: "Haiku 3.5", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
];

export interface BackendRegistryModel {
  id: string;
  label: string;
  context_window_tokens: number;
}

export interface BackendRegistrySource {
  id: string;
  label: string;
  kind?: string;
  enabled: boolean;
  capabilities: {
    thinking: boolean;
    effort: boolean;
    fast_mode: boolean;
  };
  manual_models: BackendRegistryModel[];
  discovered_models: BackendRegistryModel[];
}

export function buildModelRegistry(
  alternativeBackendsEnabled: boolean,
  backends: readonly BackendRegistrySource[],
): readonly Model[] {
  if (!alternativeBackendsEnabled) return MODELS;

  const models: Model[] = [...MODELS];
  for (const backend of backends) {
    if (!backend.enabled || backend.id === "anthropic") continue;
    const backendModels =
      backend.discovered_models.length > 0
        ? backend.discovered_models
        : backend.manual_models;
    const seen = new Set<string>();
    for (const model of backendModels) {
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({
        id: model.id,
        label: model.label || model.id,
        group: backend.label,
        extraUsage: false,
        providerId: backend.id,
        providerLabel: backend.label,
        providerQualifiedId: `${backend.id}/${model.id}`,
        supportsThinking: backend.capabilities.thinking,
        supportsEffort: backend.capabilities.effort,
        supportsFastMode: backend.capabilities.fast_mode,
        contextWindowTokens: model.context_window_tokens,
      });
    }
  }
  return models;
}

export function resolveModelSelection(
  registry: readonly Model[],
  input: string,
): Model | undefined {
  const normalized = input.trim().toLowerCase();
  return registry.find(
    (model) =>
      model.id.toLowerCase() === normalized ||
      model.providerQualifiedId?.toLowerCase() === normalized,
  );
}

export function findModelInRegistry(
  registry: readonly Model[],
  modelId: string | undefined,
  providerId = "anthropic",
): Model | undefined {
  if (!modelId) return undefined;
  const normalizedProvider = providerId || "anthropic";
  return (
    registry.find(
      (model) =>
        model.id === modelId &&
        (model.providerId ?? "anthropic") === normalizedProvider,
    ) ??
    registry.find(
      (model) => model.providerQualifiedId === `${normalizedProvider}/${modelId}`,
    ) ??
    registry.find((model) => model.id === modelId && !model.providerId) ??
    registry.find((model) => model.id === modelId)
  );
}
