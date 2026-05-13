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
  readonly providerKind?: string;
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
  // 1M context billing per Anthropic's Claude Code docs (Model configuration → Extended context):
  //   Max/Team/Enterprise → Opus 1M included with subscription; Sonnet 1M is extra usage.
  //   Pro                → both Opus 1M and Sonnet 1M are extra usage.
  // The `extraUsage` flag tracks subscription-quota inclusion, not per-token API price.
  // We optimize for Max/Team/Enterprise (Claudette's primary audience), so only Sonnet 1M
  // carries the indicator; Pro users selecting Opus 1M see no warning even though it
  // counts against their extra-usage allotment.
  { id: "opus", label: "Opus 4.7 1M", group: "Claude Code", extraUsage: false, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "sonnet", label: "Sonnet 4.6", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", group: "Claude Code", extraUsage: true, contextWindowTokens: 1_000_000 },
  { id: "haiku", label: "Haiku 4.5", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 1_000_000 },
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

type ParsedModelVersion = {
  prefix: string;
  versionKey: string;
  versionParts: number[];
  suffix: string;
};

type RankedBackendModel = {
  model: BackendRegistryModel;
  index: number;
  parsed: ParsedModelVersion | undefined;
};

const PRIMARY_BACKEND_VERSION_BANDS = 2;

function parseModelVersion(model: BackendRegistryModel): ParsedModelVersion | undefined {
  const text = `${model.id} ${model.label}`.toLowerCase();
  const match = text.match(/\b([a-z][a-z0-9]*)(?:[-\s]?)(\d+(?:[.-]\d+)*)([a-z0-9-]*)\b/);
  if (!match) return undefined;
  const versionParts = match[2]
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10));
  if (versionParts.some((part) => !Number.isFinite(part))) return undefined;
  return {
    prefix: match[1],
    versionKey: versionParts.join("."),
    versionParts,
    suffix: match[3] ?? "",
  };
}

function compareVersionPartsDesc(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function rankBackendModels(models: readonly BackendRegistryModel[]): RankedBackendModel[] {
  const prefixOrder = new Map<string, number>();
  const ranked = models.map((model, index) => {
    const parsed = parseModelVersion(model);
    if (parsed && !prefixOrder.has(parsed.prefix)) {
      prefixOrder.set(parsed.prefix, prefixOrder.size);
    }
    return { model, index, parsed };
  });

  return ranked.sort((a, b) => {
    if (!a.parsed && !b.parsed) return a.index - b.index;
    if (!a.parsed) return 1;
    if (!b.parsed) return -1;

    const prefixDiff =
      (prefixOrder.get(a.parsed.prefix) ?? a.index) -
      (prefixOrder.get(b.parsed.prefix) ?? b.index);
    if (prefixDiff !== 0) return prefixDiff;

    const versionDiff = compareVersionPartsDesc(
      a.parsed.versionParts,
      b.parsed.versionParts,
    );
    if (versionDiff !== 0) return versionDiff;

    const suffixDiff = a.parsed.suffix.localeCompare(b.parsed.suffix);
    if (suffixDiff !== 0) return suffixDiff;
    return a.index - b.index;
  });
}

function primaryVersionKeysByPrefix(
  ranked: readonly RankedBackendModel[],
): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  for (const entry of ranked) {
    if (!entry.parsed) continue;
    const versions = keys.get(entry.parsed.prefix) ?? new Set<string>();
    if (versions.size < PRIMARY_BACKEND_VERSION_BANDS) {
      versions.add(entry.parsed.versionKey);
      keys.set(entry.parsed.prefix, versions);
    }
  }
  return keys;
}

export function shouldExposeBackendModels(
  backend: BackendRegistrySource,
  alternativeBackendsEnabled: boolean,
  experimentalCodexEnabled = false,
): boolean {
  if (!backend.enabled || backend.id === "anthropic") return false;
  if (backend.kind === "codex_subscription") return false;
  if (backend.kind === "codex_native") return experimentalCodexEnabled;
  return alternativeBackendsEnabled;
}

export function buildModelRegistry(
  alternativeBackendsEnabled: boolean,
  backends: readonly BackendRegistrySource[],
  experimentalCodexEnabled = false,
): readonly Model[] {
  let models: Model[] | undefined;
  for (const backend of backends) {
    if (!shouldExposeBackendModels(
      backend,
      alternativeBackendsEnabled,
      experimentalCodexEnabled,
    )) continue;
    const backendModels =
      backend.discovered_models.length > 0
        ? backend.discovered_models
        : backend.manual_models;
    const rankedModels = rankBackendModels(backendModels);
    const primaryVersions = primaryVersionKeysByPrefix(rankedModels);
    const seen = new Set<string>();
    for (const entry of rankedModels) {
      const { model } = entry;
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      const isOlderBackendVersion = entry.parsed
        ? !primaryVersions
          .get(entry.parsed.prefix)
          ?.has(entry.parsed.versionKey)
        : false;
      const isNativeCodex = backend.kind === "codex_native";
      const target = models ??= [...MODELS];
      target.push({
        id: model.id,
        label: model.label || model.id,
        group: backend.label,
        extraUsage: false,
        legacy: isOlderBackendVersion,
        providerId: backend.id,
        providerLabel: backend.label,
        providerKind: backend.kind,
        providerQualifiedId: `${backend.id}/${model.id}`,
        supportsThinking: isNativeCodex || backend.capabilities.thinking,
        supportsEffort: isNativeCodex || backend.capabilities.effort,
        supportsFastMode: isNativeCodex || backend.capabilities.fast_mode,
        contextWindowTokens: model.context_window_tokens,
      });
    }
  }
  return models ?? MODELS;
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
