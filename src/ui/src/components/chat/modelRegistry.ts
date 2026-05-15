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
  /** Demoted out of the primary list.
   *  - Claude Code models: hidden behind the global "More" disclosure.
   *  - Pi models: hidden behind their sub-section's "Show all (M)…"
   *    disclosure (the picker checks `providerKind === "pi_sdk"` to
   *    pick the right scope). */
  readonly legacy?: boolean;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly providerKind?: string;
  readonly providerQualifiedId?: string;
  /** Display label of the *sub-provider* within a Pi-style aggregator
   *  backend (e.g. "OpenAI", "Anthropic", "Ollama"). Parsed from the
   *  `<provider>/<modelId>` id the Pi sidecar emits. Only populated for
   *  `providerKind === "pi_sdk"`; undefined for every other backend
   *  (Claude Code curated, Codex, Ollama-via-Claude-CLI, etc.). */
  readonly subProvider?: string;
  /** Raw provider key (lowercased) used for stable identity in tests
   *  and the Anthropic-via-Pi hide. */
  readonly subProviderKey?: string;
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

/** Soft cap per Pi sub-provider before models get demoted to the
 *  "Show all (M)…" disclosure. Picked to keep the dropdown readable
 *  without forcing the user to expand a section for the obvious top
 *  choice. The full registry is always reachable via the per-sub-section
 *  search popover. */
export const PI_SUBSECTION_PRIMARY_CAP = 5;

/** Friendly display labels for Pi's well-known provider keys. Anything
 *  not in this table falls through to `titleCaseProviderKey`, which
 *  capitalizes the first letter and leaves hyphens / dots alone so a
 *  newly-added Pi provider still renders sensibly without a code edit. */
const PI_PROVIDER_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  qwen: "Qwen",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  moonshot: "MoonshotAI",
  moonshotai: "MoonshotAI",
  poolside: "Poolside",
  arcee: "Arcee AI",
  reka: "Reka",
  relace: "Relace",
  baidu: "Baidu Qianfan",
  owl: "Owl",
  router: "Router",
};

function titleCaseProviderKey(key: string): string {
  if (!key) return "Other";
  if (key.length <= 3) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Resolve a Pi provider key (the prefix before `/` in a model id) to
 *  its display label. Returns `{ key: "other", label: "Other" }` for
 *  ids that don't follow the `provider/modelId` shape. */
export function resolvePiSubProvider(
  modelId: string,
): { key: string; label: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { key: "other", label: "Other" };
  const rawKey = modelId.slice(0, slash).toLowerCase().trim();
  if (!rawKey) return { key: "other", label: "Other" };
  const label = PI_PROVIDER_DISPLAY_LABELS[rawKey] ?? titleCaseProviderKey(rawKey);
  return { key: rawKey, label };
}

export interface PiDiscoveredGroup<M> {
  key: string;
  label: string;
  models: M[];
}

/**
 * Group Pi-discovered models by sub-provider (parsed from the
 * `provider/modelId` prefix the sidecar emits). Sub-providers are
 * sorted by model count descending so the biggest catalogs surface
 * first — ties break alphabetically by display label.
 *
 * Pure grouping helper, shared between the Settings card render and
 * its regression tests. Generic over the model shape so the same
 * function works with `BackendRegistryModel`, `AgentBackendModel`,
 * or any other `{ id: string }` payload.
 */
export function groupPiDiscoveredModels<M extends { id: string }>(
  models: readonly M[],
): PiDiscoveredGroup<M>[] {
  const groups = new Map<string, PiDiscoveredGroup<M>>();
  for (const model of models) {
    const { key, label } = resolvePiSubProvider(model.id);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return Array.from(groups.values()).sort((a, b) => {
    const sizeDiff = b.models.length - a.models.length;
    if (sizeDiff !== 0) return sizeDiff;
    return a.label.localeCompare(b.label);
  });
}

function parseModelVersion(model: BackendRegistryModel): ParsedModelVersion | undefined {
  const text = `${model.id} ${model.label}`.toLowerCase();
  // Heuristic for provider-supplied model ids, not a strict semantic-version
  // parser. We intentionally keep variant suffixes inside the same prefix band
  // so API-family lists (for example gpt-5.x plus codex/spark variants) do not
  // promote every cosmetic suffix into the primary group.
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
  codexEnabled = false,
): boolean {
  if (!backend.enabled || backend.id === "anthropic") return false;
  if (backend.kind === "codex_subscription") return false;
  if (backend.kind === "codex_native") return codexEnabled;
  if (backend.kind === "pi_sdk") return true;
  return alternativeBackendsEnabled;
}

export function buildModelRegistry(
  alternativeBackendsEnabled: boolean,
  backends: readonly BackendRegistrySource[],
  codexEnabled = false,
): readonly Model[] {
  let models: Model[] | undefined;
  for (const backend of backends) {
    if (!shouldExposeBackendModels(
      backend,
      alternativeBackendsEnabled,
      codexEnabled,
    )) continue;
    const backendModels =
      backend.discovered_models.length > 0
        ? backend.discovered_models
        : backend.manual_models;
    const isPi = backend.kind === "pi_sdk";
    const target = models ??= [...MODELS];
    if (isPi) {
      collectPiModelsBySubProvider(backend, backendModels, target);
      continue;
    }
    collectFlatBackendModels(backend, backendModels, target);
  }
  return models ?? MODELS;
}

function collectFlatBackendModels(
  backend: BackendRegistrySource,
  backendModels: readonly BackendRegistryModel[],
  target: Model[],
): void {
  const rankedModels = rankBackendModels(backendModels);
  const primaryVersions = primaryVersionKeysByPrefix(rankedModels);
  const seen = new Set<string>();
  for (const entry of rankedModels) {
    const { model } = entry;
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const isNativeCodex = backend.kind === "codex_native";
    const providerDisplayLabel = isNativeCodex ? "Codex" : backend.label;
    const isOlderBackendVersion = entry.parsed
      ? !primaryVersions.get(entry.parsed.prefix)?.has(entry.parsed.versionKey)
      : false;
    target.push({
      id: model.id,
      label: model.label || model.id,
      group: providerDisplayLabel,
      extraUsage: false,
      legacy: isOlderBackendVersion,
      providerId: backend.id,
      providerLabel: providerDisplayLabel,
      providerKind: backend.kind,
      providerQualifiedId: `${backend.id}/${model.id}`,
      supportsThinking: isNativeCodex || backend.capabilities.thinking,
      supportsEffort: isNativeCodex || backend.capabilities.effort,
      supportsFastMode: isNativeCodex || backend.capabilities.fast_mode,
      contextWindowTokens: model.context_window_tokens,
    });
  }
}

/**
 * Pi's `ModelRegistry.getAvailable()` mixes many real providers (OpenAI,
 * Anthropic, Google, Ollama, …) under one backend. Splitting by the
 * `provider/` prefix in each id lets the picker render scannable
 * sub-sections instead of a 370-row wall. Each sub-section keeps its
 * own version-band ranking so e.g. older GPT versions collapse into
 * "Show all" alongside other openai entries, not alongside Anthropic.
 */
function collectPiModelsBySubProvider(
  backend: BackendRegistrySource,
  backendModels: readonly BackendRegistryModel[],
  target: Model[],
): void {
  const bySubProvider = new Map<string, BackendRegistryModel[]>();
  const subProviderLabels = new Map<string, string>();
  const subProviderOrder: string[] = [];
  for (const model of backendModels) {
    if (!model.id) continue;
    const { key, label } = resolvePiSubProvider(model.id);
    if (!bySubProvider.has(key)) {
      bySubProvider.set(key, []);
      subProviderLabels.set(key, label);
      subProviderOrder.push(key);
    }
    bySubProvider.get(key)!.push(model);
  }
  for (const subKey of subProviderOrder) {
    const subLabel = subProviderLabels.get(subKey) ?? "Other";
    const subModels = bySubProvider.get(subKey) ?? [];
    const ranked = rankBackendModels(subModels);
    const primaryVersions = primaryVersionKeysByPrefix(ranked);
    const seen = new Set<string>();
    let primaryCountForSub = 0;
    for (const entry of ranked) {
      const { model } = entry;
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      const versionDemoted = entry.parsed
        ? !primaryVersions.get(entry.parsed.prefix)?.has(entry.parsed.versionKey)
        : false;
      // Per-sub-section cap. A version-demoted entry is already legacy;
      // anything else past the cap is overflow within its sub-section.
      const overCap = primaryCountForSub >= PI_SUBSECTION_PRIMARY_CAP;
      const legacy = versionDemoted || overCap;
      if (!legacy) primaryCountForSub += 1;
      target.push({
        id: model.id,
        label: model.label || model.id,
        group: "Pi",
        extraUsage: false,
        legacy,
        providerId: backend.id,
        providerLabel: "Pi",
        providerKind: backend.kind,
        providerQualifiedId: `${backend.id}/${model.id}`,
        subProvider: subLabel,
        subProviderKey: subKey,
        supportsThinking: backend.capabilities.thinking,
        supportsEffort: backend.capabilities.effort,
        supportsFastMode: backend.capabilities.fast_mode,
        contextWindowTokens: model.context_window_tokens,
      });
    }
  }
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
