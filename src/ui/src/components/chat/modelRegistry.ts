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
  /** Effective harness the resolver will pick for this model's backend
   *  at send time. The picker uses this to surface "via Pi" / "via
   *  Claude CLI" badges on aggregated-backend sections (Ollama, LM
   *  Studio) so the user can see the dispatch path without opening
   *  Settings. Not set for Claude Code curated models (which are always
   *  `claude_code` — use `getHarnessForModel` if you need the resolved
   *  value with that fallback applied). Populated for every
   *  backend-injected entry, including the Pi card, so the chat
   *  model-switch path can detect same- vs cross-harness changes
   *  uniformly. The redundant-badge suppression for Pi-on-Pi /
   *  Codex-on-CodexAppServer lives in `ModelSelector`'s
   *  `runtimeBadge` filter, not here. Possible values:
   *  `"pi_sdk"`, `"claude_code"`, `"codex_app_server"`. */
  readonly runtimeHarness?: string;
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
  ollama: "pi_sdk",
  lm_studio: "pi_sdk",
  openai_api: "claude_code",
  custom_openai: "claude_code",
  codex_native: "codex_app_server",
  pi_sdk: "pi_sdk",
};

/** Sanctioned harnesses per kind. Mirror of `availableHarnessesForKind`
 *  in `services/tauri/agentBackends.ts`. Used to validate the persisted
 *  override defensively — a stale override outside the allow-list falls
 *  back to the kind's default, same as the Rust resolver does. */
export const AVAILABLE_HARNESSES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["claude_code"],
  custom_anthropic: ["claude_code"],
  codex_subscription: ["claude_code"],
  ollama: ["pi_sdk", "claude_code"],
  lm_studio: ["pi_sdk", "claude_code"],
  openai_api: ["claude_code", "pi_sdk"],
  custom_openai: ["claude_code", "pi_sdk"],
  codex_native: ["codex_app_server", "pi_sdk"],
  pi_sdk: ["pi_sdk"],
};

/**
 * Compute the harness a backend will *actually* resolve to at send
 * time. Mirrors `resolve_dispatch_harness` in
 * `src-tauri/src/commands/agent_backends.rs` — in particular the
 * Pi-disabled downgrade: when the Pi card is off, non-Pi-kind
 * backends that default/override to Pi fall through to their first
 * non-Pi sanctioned harness, otherwise the picker's "via Pi" badge
 * would lie about the dispatch path until the user re-enabled the
 * Pi card.
 *
 * `piEnabled` is the runtime "is the Pi backend reachable?" signal —
 * `false` triggers the downgrade. The Pi card itself short-circuits
 * the check because its own enabled flag is the gate elsewhere
 * (Settings hides the card and `resolve_backend_runtime` rejects
 * disabled backends).
 */
function resolveEffectiveHarness(
  source: BackendRegistrySource,
  piEnabled: boolean,
): string | undefined {
  if (!source.kind) return undefined;
  const allowed = AVAILABLE_HARNESSES_BY_KIND[source.kind];
  const override = source.runtime_harness ?? undefined;
  const harness =
    override && allowed?.includes(override)
      ? override
      : DEFAULT_HARNESS_BY_KIND[source.kind];
  if (
    harness === "pi_sdk"
    && source.kind !== "pi_sdk"
    && !piEnabled
  ) {
    // First non-Pi entry the kind sanctions — same fallback logic the
    // Rust resolver uses. `available_harnesses` is ordered with the
    // kind's preferred default first; we look for the first non-Pi
    // sanctioned harness so e.g. Codex Native falls through to its
    // app-server runtime instead of jumping to Claude CLI.
    const fallback = allowed?.find((h) => h !== "pi_sdk");
    if (fallback) return fallback;
  }
  return harness;
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
  piSdkAvailable = true,
): boolean {
  if (!backend.enabled || backend.id === "anthropic") return false;
  if (backend.kind === "codex_subscription") return false;
  if (backend.kind === "codex_native") return codexEnabled;
  // Defense in depth: even when a stale Pi backend row makes it into
  // the store (e.g. a remote-server connection that exposes Pi rows
  // back to a local no-pi build), the model picker must not surface
  // them on builds where the Pi harness can't actually dispatch.
  // The Rust loader normally drops Pi rows in a no-pi build, but the
  // contract is "hide Pi when not compiled in" — pin it here too.
  if (backend.kind === "pi_sdk") return piSdkAvailable;
  return alternativeBackendsEnabled;
}

/**
 * Optional behavior knobs for the model registry. Lives on its own
 * object instead of additional positional arguments so future flags
 * (e.g. a global model-search visibility gate) compose without
 * breaking every call site.
 */
export interface ModelRegistryOptions {
  /**
   * True when the local Claude CLI is signed in with a `oauth_token`
   * auth method (a Pro / Max subscription). The Rust resolver refuses
   * to route Pi/`anthropic/*` and Pi/`claude/*` selections in that
   * mode (`ensure_anthropic_not_routed_through_pi_via_oauth` in
   * `src-tauri/src/commands/agent_backends.rs`) so we hide those rows
   * at the registry source rather than only in the chat picker.
   * Without this filter the Settings default-model dropdown, the
   * `/model` slash command, and the toolbar selectors would still
   * surface ids that the resolver rejects mid-send.
   */
  isClaudeOauthSubscriber?: boolean;
  /**
   * False when the host binary was built without the `pi-sdk` cargo
   * feature. The Rust loader normally suppresses Pi rows in that case,
   * but the model registry double-checks here so a remote-server
   * connection (or any future source that bypasses the loader) can't
   * leak Pi rows into the no-pi UI. Defaults to `true` so existing
   * unit-test fixtures keep their full surface without modification.
   */
  piSdkAvailable?: boolean;
}

export function buildModelRegistry(
  alternativeBackendsEnabled: boolean,
  backends: readonly BackendRegistrySource[],
  codexEnabled = false,
  options: ModelRegistryOptions = {},
): readonly Model[] {
  const isClaudeOauthSubscriber = options.isClaudeOauthSubscriber === true;
  const piSdkAvailable = options.piSdkAvailable !== false;
  // Pi-disabled downgrade: when no enabled Pi backend exists, non-Pi
  // cards that point at the Pi harness fall through to their first
  // sanctioned non-Pi runtime — same logic as `resolve_dispatch_harness`
  // in `agent_backends.rs`. Compute once so every per-backend pass
  // through `resolveEffectiveHarness` reports the dispatch path the
  // resolver will actually take.
  const piEnabled = backends.some(
    (b) => b.kind === "pi_sdk" && b.enabled,
  );
  let models: Model[] | undefined;
  for (const backend of backends) {
    if (!shouldExposeBackendModels(
      backend,
      alternativeBackendsEnabled,
      codexEnabled,
      piSdkAvailable,
    )) continue;
    const backendModels =
      backend.discovered_models.length > 0
        ? backend.discovered_models
        : backend.manual_models;
    const isPi = backend.kind === "pi_sdk";
    const target = models ??= [...MODELS];
    if (isPi) {
      collectPiModelsBySubProvider(backend, backendModels, target, {
        isClaudeOauthSubscriber,
      });
      continue;
    }
    collectFlatBackendModels(backend, backendModels, target, piEnabled);
  }
  return models ?? MODELS;
}

function collectFlatBackendModels(
  backend: BackendRegistrySource,
  backendModels: readonly BackendRegistryModel[],
  target: Model[],
  piEnabled: boolean,
): void {
  const rankedModels = rankBackendModels(backendModels);
  const primaryVersions = primaryVersionKeysByPrefix(rankedModels);
  const seen = new Set<string>();
  // Compute the effective harness once per backend. The Pi-routing
  // badge in the picker reads this off any model in the section.
  const runtimeHarness = resolveEffectiveHarness(backend, piEnabled);
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

/**
 * Pi's `ModelRegistry.getAvailable()` mixes many real providers (OpenAI,
 * Anthropic, Google, Ollama, …) under one backend. Splitting by the
 * `provider/` prefix in each id lets the picker render scannable
 * sub-sections instead of a 370-row wall. Each sub-section keeps its
 * own version-band ranking so e.g. older GPT versions collapse into
 * "Show all" alongside other openai entries, not alongside Anthropic.
 */
interface CollectPiModelsOptions {
  isClaudeOauthSubscriber: boolean;
}

function collectPiModelsBySubProvider(
  backend: BackendRegistrySource,
  backendModels: readonly BackendRegistryModel[],
  target: Model[],
  options: CollectPiModelsOptions,
): void {
  // Pi card always dispatches via the Pi harness; the Pi-disabled
  // downgrade in `resolveEffectiveHarness` does not apply when the
  // source's own kind is `pi_sdk`. Pass `piEnabled=true` explicitly so
  // the call stays self-evident.
  const runtimeHarness = resolveEffectiveHarness(backend, /* piEnabled */ true);
  const bySubProvider = new Map<string, BackendRegistryModel[]>();
  const subProviderLabels = new Map<string, string>();
  const subProviderOrder: string[] = [];
  for (const model of backendModels) {
    if (!model.id) continue;
    const { key, label } = resolvePiSubProvider(model.id);
    // OAuth subscription users can't route Anthropic-or-Claude
    // models through Pi (the Rust resolver refuses), so strip them
    // here so they never reach any registry consumer — picker,
    // Settings default-model dropdown, `/model` slash command, or
    // the toolbar selectors. Mirrors `pi_model_targets_anthropic`
    // in `agent_backends.rs`.
    if (
      options.isClaudeOauthSubscriber
      && (key === "anthropic" || key === "claude")
    ) {
      continue;
    }
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
        runtimeHarness,
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

/**
 * Resolve the runtime harness a given model resolves to at send time.
 *
 * Used by the chat-toolbar model picker to decide whether a model swap
 * is a warm in-place change (same harness — the persistent subprocess
 * gets respawned with `--model <new>` and `--resume <prior-sid>`, full
 * conversation preserved) or a cross-harness migration (different
 * transcript format — currently triggers a session reset; Phase 2 of
 * the model-switch plan will replace that with a transcript migration).
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
