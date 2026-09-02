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
  /** Demoted out of the primary list: Claude Code models hidden behind
   *  the global "More" disclosure. */
  readonly legacy?: boolean;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly providerKind?: string;
  readonly providerQualifiedId?: string;
  /** Effective harness the resolver will pick for this model's backend
   *  at send time. Not set for Claude Code curated models (which are
   *  always `claude_code` — use `getHarnessForModel` if you need the
   *  resolved value with that fallback applied). Populated for every
   *  backend-injected entry so the chat model-switch path can detect
   *  same- vs cross-harness changes uniformly. Possible values:
   *  `"claude_code"`, `"codex_app_server"`. */
  readonly runtimeHarness?: string;
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
  // No `opus` entry: Opus 5 is natively 1M with no 200K variant to fall back
  // to, so `get1mFallback("opus")` correctly returns "opus" unchanged.
  // No `sonnet` entry: Sonnet 5 is natively 1M with no 200K variant to fall
  // back to, so `get1mFallback("sonnet")` correctly returns "sonnet" unchanged.
  // No `claude-fable-5-1` entry either, for the same reason — Fable 5.1's 1M
  // window is its default, not an opt-in `[1m]` selection.
  "claude-fable-5[1m]": "claude-fable-5",
  "claude-opus-4-8[1m]": "claude-opus-4-8",
  "claude-opus-4-7[1m]": "claude-opus-4-7",
  "claude-sonnet-4-6[1m]": "claude-sonnet-4-6",
  "claude-opus-4-6[1m]": "claude-opus-4-6",
};

export function get1mFallback(modelId: string): string {
  return NON_1M_FALLBACKS[modelId] ?? modelId;
}

export const MODELS: readonly Model[] = [
  // 1M context billing per Anthropic's Claude Code docs (Model configuration → Extended context):
  //   Max/Team/Enterprise → legacy Opus 4.8 1M is included with subscription; legacy Sonnet 4.6 1M is extra usage.
  //   Pro                → both legacy Opus 4.8 1M and legacy Sonnet 4.6 1M are extra usage.
  // Opus 5, Sonnet 5 and Fable 5.1 are exceptions: their 1M windows are native and included
  // at standard pricing on every plan, so none of them carries an `extraUsage` indicator
  // (see the `opus`, `sonnet` and `claude-fable-5-1` rows below).
  // The `extraUsage` flag tracks subscription-quota inclusion, not per-token API price.
  // We optimize for Max/Team/Enterprise (Claudette's primary audience), so only legacy
  // Sonnet 4.6 1M carries the indicator; Pro users selecting legacy Opus 4.8 1M see no
  // warning even though it counts against their extra-usage allotment.
  // `opus` is the bare alias the Claude CLI resolves to the latest Opus — now Opus 5,
  // which (like Sonnet 5) runs natively at 1M context with no 200K variant, no `[1m]`
  // suffix to select, and no usage credits on any plan — Anthropic recommends it as
  // Claude Code's default. So unlike Opus 4.8, there is no separate concrete
  // `claude-opus-5` row: the alias itself is the 1M model.
  { id: "opus", label: "Opus 5", group: "Claude Code", extraUsage: false, contextWindowTokens: 1_000_000 },
  // `sonnet` is the bare alias the Claude CLI resolves to the latest Sonnet — now Sonnet 5,
  // which runs natively at 1M context (no 200K variant, no `[1m]` suffix to select, no usage
  // credits on any plan — Claude Code model-config docs, "Sonnet 5 context window"). So unlike
  // Sonnet 4.6, there is no separate 1M row: the alias itself is the 1M model.
  { id: "sonnet", label: "Sonnet 5", group: "Claude Code", extraUsage: false, contextWindowTokens: 1_000_000 },
  { id: "haiku", label: "Haiku 4.5", group: "Claude Code", extraUsage: false, contextWindowTokens: 200_000 },
  // Fable 5.1 is the current Fable — Anthropic's most capable widely released model,
  // Opus-class effort support incl. xhigh/max. Like Opus 5 and Sonnet 5, its 1M window
  // is the default *and* the maximum, so there is no 200K row and no `[1m]` variant to
  // select. The Fable family has no bare alias: the concrete id carries through to the
  // Claude CLI `--model` arg and passes the `claude-` prefix gate in `gateway_translate.rs`.
  { id: "claude-fable-5-1", label: "Fable 5.1", group: "Claude Code", extraUsage: false, contextWindowTokens: 1_000_000 },
  // Fable 5 demoted to the "More" disclosure when Fable 5.1 became the current Fable.
  // Both context sizes stay pinned (Fable 5 defaults to 200K and needs the `[1m]`
  // suffix for its 1M window) so the ids survive the promotion.
  { id: "claude-fable-5", label: "Fable 5", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-fable-5[1m]", label: "Fable 5 1M", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 1_000_000 },
  // Opus 4.8 demoted to the "More" disclosure when `opus` moved to Opus 5. Both the
  // 200K default and 1M variant are pinned here (the paths the `opus` alias used to
  // resolve to for each context size) so they survive the alias move.
  { id: "claude-opus-4-8", label: "Opus 4.8", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 1_000_000 },
  { id: "claude-opus-4-5", label: "Opus 4.5", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  // Sonnet 4.6 demoted to the "More" disclosure when `sonnet` moved to Sonnet 5.
  // The 200K id is pinned here (the path the `sonnet` alias used to resolve to)
  // so it survives the alias move; the 1M variant keeps its `extraUsage` flag.
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", group: "Claude Code", extraUsage: false, legacy: true, contextWindowTokens: 200_000 },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", group: "Claude Code", extraUsage: true, legacy: true, contextWindowTokens: 1_000_000 },
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
  /** Persisted runtime override. When undefined / null, the kind's
   *  default applies. Mirror of `AgentBackendConfig.runtime_harness`. */
  runtime_harness?: string | null;
}

/** Default harness per kind. Inlined to avoid pulling `services/tauri`
 *  into this non-React module — mirrors `defaultHarnessForKind`
 *  there. Both mirrors are pinned to the canonical matrix at
 *  `src/agent_backend_matrix.json` by `harnessMatrix.test.ts`. */
export const DEFAULT_HARNESS_BY_KIND: Readonly<Record<string, string>> = {
  anthropic: "claude_code",
  custom_anthropic: "claude_code",
  codex_subscription: "claude_code",
  ollama: "claude_code",
  openai_api: "claude_code",
  custom_openai: "claude_code",
  codex_native: "codex_app_server",
};

/** Sanctioned harnesses per kind. Mirror of `availableHarnessesForKind`
 *  in `services/tauri/agentBackends.ts`. Used to validate the persisted
 *  override defensively — a stale override outside the allow-list falls
 *  back to the kind's default, same as the Rust resolver does. */
export const AVAILABLE_HARNESSES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["claude_code"],
  custom_anthropic: ["claude_code"],
  codex_subscription: ["claude_code"],
  ollama: ["claude_code"],
  openai_api: ["claude_code"],
  custom_openai: ["claude_code"],
  codex_native: ["codex_app_server"],
};

/**
 * Compute the harness a backend will *actually* resolve to at send
 * time. Mirrors `AgentBackendConfig::effective_harness` on the Rust
 * side: the persisted override when it's in the kind's allow-list,
 * otherwise the kind's default.
 */
function resolveEffectiveHarness(
  source: BackendRegistrySource,
): string | undefined {
  if (!source.kind) return undefined;
  const allowed = AVAILABLE_HARNESSES_BY_KIND[source.kind];
  const override = source.runtime_harness ?? undefined;
  return override && allowed?.includes(override)
    ? override
    : DEFAULT_HARNESS_BY_KIND[source.kind];
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
    const target = models ??= [...MODELS];
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
  // Compute the effective harness once per backend.
  const runtimeHarness = resolveEffectiveHarness(backend);
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
      runtimeHarness,
      supportsThinking: isNativeCodex || backend.capabilities.thinking,
      supportsEffort: isNativeCodex || backend.capabilities.effort,
      supportsFastMode: isNativeCodex || backend.capabilities.fast_mode,
      contextWindowTokens: model.context_window_tokens,
    });
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

/**
 * Strict variant of {@link findModelInRegistry}: resolves only when the
 * entry's own backend matches `providerId`.
 *
 * `findModelInRegistry` deliberately ends with two cross-provider bare-id
 * fallbacks so a loosely-specified selection (a user typing
 * `/model gpt-5.5` without naming a backend) still lands somewhere. That is
 * wrong for anything holding a *persisted* `(model, provider)` pair, where
 * the provider is part of the stored identity: if the named backend is
 * disabled and some other one happens to expose the same model id, the
 * lenient lookup silently substitutes that other backend — which can also
 * mean a different runtime harness (`codex_app_server` vs `claude_code`).
 *
 * Callers holding a persisted pair want "resolve exactly, or tell me it's
 * unavailable" instead, so they can fall back deliberately rather than
 * silently running somewhere the user never chose.
 *
 * Curated Claude Code entries carry no `providerId` and normalize to
 * `"anthropic"`, matching how the pair is persisted.
 */
export function findProviderQualifiedModel(
  registry: readonly Model[],
  modelId: string | null | undefined,
  providerId: string | null | undefined,
): Model | undefined {
  if (!modelId) return undefined;
  const normalizedProvider = providerId || "anthropic";
  const entry = findModelInRegistry(registry, modelId, normalizedProvider);
  if (!entry) return undefined;
  return (entry.providerId ?? "anthropic") === normalizedProvider
    ? entry
    : undefined;
}

/**
 * Resolve the runtime harness a given model resolves to at send time.
 *
 * Used by the chat-toolbar model picker to decide whether a model swap
 * is a warm in-place change (same harness — the persistent subprocess
 * gets respawned with `--model <new>` and `--resume <prior-sid>`, full
 * conversation preserved) or a cross-harness migration (different
 * transcript format — the prior transcript can't be replayed wire-for-wire,
 * so the backend mints a fresh session id and seeds a synthetic
 * `<conversation-history>` prelude into the next user turn via
 * `prepare_cross_harness_migration` so the new harness still sees the
 * preceding turns).
 *
 * Returns `undefined` only when the model isn't in the registry at all.
 * Curated Claude Code entries in `MODELS` don't carry a `runtimeHarness`
 * field — they're always `claude_code`, which we substitute here so
 * callers don't need to special-case the curated list.
 */
export function getHarnessForModel(
  registry: readonly Model[],
  modelId: string | undefined,
  providerId = "anthropic",
): string | undefined {
  const entry = findModelInRegistry(registry, modelId, providerId);
  if (!entry) return undefined;
  return entry.runtimeHarness ?? "claude_code";
}
