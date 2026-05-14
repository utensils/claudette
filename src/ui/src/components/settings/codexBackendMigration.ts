import { DEFAULT_CLAUDE_BACKEND, DEFAULT_CLAUDE_MODEL } from "./alternativeBackendCleanup";

export const LEGACY_CODEX_BACKEND = "codex-subscription";
export const NATIVE_CODEX_BACKEND = "experimental-codex";
export const FIRST_CLASS_BACKENDS_PROMOTION_KEY = "agent_backends_first_class_promoted";

export type SettingEntry = readonly [string, string];

export interface CodexBackendGateMigrationInput {
  enableNative: boolean;
  defaultBackend: string | null;
  sessionProviders: readonly SettingEntry[];
  selectedProviders: Readonly<Record<string, string>>;
}

export interface CodexBackendGateMigrationPlan {
  fromBackend: string;
  toBackend: string;
  toModel: string | null;
  defaultBackend: string | null;
  resetDefault: boolean;
  sessionIds: string[];
}

export interface CodexBackendMigrationModel {
  id: string;
}

export interface CodexBackendMigrationBackend {
  id: string;
  default_model: string | null;
  manual_models: readonly CodexBackendMigrationModel[];
  discovered_models: readonly CodexBackendMigrationModel[];
}

export interface CodexBackendMigrationModelInput {
  plan: Pick<CodexBackendGateMigrationPlan, "toBackend" | "toModel">;
  sessionId: string;
  persistedModels: ReadonlyMap<string, string>;
  selectedModels: Readonly<Record<string, string>>;
  backends: readonly CodexBackendMigrationBackend[];
}

export interface ExperimentalBackendGateLoadInput {
  alternativeBackendsCompiled: boolean;
  alternativeBackendsSetting: string | null;
  experimentalCodexSetting: string | null;
  promotionSetting: string | null;
}

export interface ExperimentalBackendGateLoadPlan {
  alternativeBackendsEnabled: boolean;
  experimentalCodexEnabled: boolean;
  shouldPersistPromotion: boolean;
}

type GateSettingLoad =
  | { status: "fulfilled"; value: string | null }
  | { status: "rejected"; reason: unknown };

function settingSessionId(key: string, prefix: string): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function modelsForBackend(
  backend: CodexBackendMigrationBackend | undefined,
): readonly CodexBackendMigrationModel[] {
  if (!backend) return [];
  return backend.discovered_models.length > 0
    ? backend.discovered_models
    : backend.manual_models;
}

function fallbackModelForBackend(
  backend: CodexBackendMigrationBackend | undefined,
): string | null {
  const models = modelsForBackend(backend);
  if (!backend) return null;
  if (backend.default_model && models.some((model) => model.id === backend.default_model)) {
    return backend.default_model;
  }
  return models[0]?.id ?? null;
}

export function planExperimentalBackendGateLoad({
  alternativeBackendsCompiled,
  alternativeBackendsSetting,
  experimentalCodexSetting,
  promotionSetting,
}: ExperimentalBackendGateLoadInput): ExperimentalBackendGateLoadPlan {
  if (!alternativeBackendsCompiled) {
    return {
      alternativeBackendsEnabled: false,
      experimentalCodexEnabled: false,
      shouldPersistPromotion: false,
    };
  }

  if (promotionSetting !== "true") {
    return {
      alternativeBackendsEnabled: true,
      experimentalCodexEnabled: true,
      shouldPersistPromotion: true,
    };
  }

  const experimentalCodexEnabled =
    experimentalCodexSetting !== "false";
  const alternativeBackendsEnabled =
    alternativeBackendsSetting !== "false";

  return {
    alternativeBackendsEnabled,
    experimentalCodexEnabled,
    shouldPersistPromotion: false,
  };
}

export function planExperimentalBackendGateLoadFromResults({
  alternativeBackendsCompiled,
  alternativeBackendsSetting,
  experimentalCodexSetting,
  promotionSetting,
}: {
  alternativeBackendsCompiled: boolean;
  alternativeBackendsSetting: GateSettingLoad;
  experimentalCodexSetting: GateSettingLoad;
  promotionSetting: GateSettingLoad;
}): ExperimentalBackendGateLoadPlan | null {
  if (
    alternativeBackendsSetting.status === "rejected" ||
    experimentalCodexSetting.status === "rejected" ||
    promotionSetting.status === "rejected"
  ) {
    return null;
  }

  return planExperimentalBackendGateLoad({
    alternativeBackendsCompiled,
    alternativeBackendsSetting: alternativeBackendsSetting.value,
    experimentalCodexSetting: experimentalCodexSetting.value,
    promotionSetting: promotionSetting.value,
  });
}

export function planCodexBackendGateMigration({
  enableNative,
  defaultBackend,
  sessionProviders,
  selectedProviders,
}: CodexBackendGateMigrationInput): CodexBackendGateMigrationPlan {
  const fromBackend = enableNative ? LEGACY_CODEX_BACKEND : NATIVE_CODEX_BACKEND;
  const toBackend = enableNative ? NATIVE_CODEX_BACKEND : DEFAULT_CLAUDE_BACKEND;
  const toModel = enableNative ? null : DEFAULT_CLAUDE_MODEL;
  const sessionIds = new Set<string>();

  for (const [key, value] of sessionProviders) {
    const sessionId = settingSessionId(key, "model_provider:");
    if (sessionId && value === fromBackend) sessionIds.add(sessionId);
  }
  for (const [sessionId, provider] of Object.entries(selectedProviders)) {
    if (provider === fromBackend) sessionIds.add(sessionId);
  }

  return {
    fromBackend,
    toBackend,
    toModel,
    defaultBackend: defaultBackend === fromBackend ? toBackend : defaultBackend,
    resetDefault: defaultBackend === fromBackend,
    sessionIds: [...sessionIds].sort(),
  };
}

export function resolveCodexBackendMigrationModel({
  plan,
  sessionId,
  persistedModels,
  selectedModels,
  backends,
}: CodexBackendMigrationModelInput): string | null {
  if (plan.toModel) return plan.toModel;

  const backend = backends.find((candidate) => candidate.id === plan.toBackend);
  const models = modelsForBackend(backend);
  const candidate = persistedModels.get(sessionId) ?? selectedModels[sessionId] ?? null;
  if (candidate && models.some((model) => model.id === candidate)) {
    return candidate;
  }

  return fallbackModelForBackend(backend);
}
