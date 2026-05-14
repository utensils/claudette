import { MODELS } from "../chat/modelRegistry";

export const DEFAULT_CLAUDE_BACKEND = "anthropic";
export const DEFAULT_CLAUDE_MODEL = "opus";
const CODEX_BACKENDS = new Set(["experimental-codex", "codex-subscription"]);

export type SettingEntry = readonly [string, string];

export interface AlternativeBackendCleanupInput {
  defaultModel: string | null;
  defaultBackend: string | null;
  sessionModels: readonly SettingEntry[];
  sessionProviders: readonly SettingEntry[];
  selectedModels: Readonly<Record<string, string>>;
  selectedProviders: Readonly<Record<string, string>>;
}

export interface AlternativeBackendCleanupPlan {
  defaultModel: string;
  defaultBackend: string;
  resetDefault: boolean;
  sessionIds: string[];
}

const BUILT_IN_CLAUDE_MODELS = new Set(MODELS.map((model) => model.id));

function settingSessionId(key: string, prefix: string): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

export function isBuiltInClaudeModel(model: string | null | undefined): boolean {
  return !!model && BUILT_IN_CLAUDE_MODELS.has(model);
}

export function isAlternativeBackendSelection(
  model: string | null | undefined,
  backend: string | null | undefined,
): boolean {
  const normalizedBackend = backend || DEFAULT_CLAUDE_BACKEND;
  if (CODEX_BACKENDS.has(normalizedBackend)) return false;
  return normalizedBackend !== DEFAULT_CLAUDE_BACKEND || (!!model && !isBuiltInClaudeModel(model));
}

export function planAlternativeBackendDisableCleanup({
  defaultModel,
  defaultBackend,
  sessionModels,
  sessionProviders,
  selectedModels,
  selectedProviders,
}: AlternativeBackendCleanupInput): AlternativeBackendCleanupPlan {
  const resetDefault = isAlternativeBackendSelection(defaultModel, defaultBackend);
  const nextDefaultModel =
    resetDefault || !isBuiltInClaudeModel(defaultModel)
      ? DEFAULT_CLAUDE_MODEL
      : (defaultModel ?? DEFAULT_CLAUDE_MODEL);
  const persistedModels = new Map<string, string>();
  const persistedProviders = new Map<string, string>();
  const sessionIds = new Set<string>();

  for (const [key, value] of sessionModels) {
    const sessionId = settingSessionId(key, "model:");
    if (!sessionId) continue;
    persistedModels.set(sessionId, value);
    sessionIds.add(sessionId);
  }
  for (const [key, value] of sessionProviders) {
    const sessionId = settingSessionId(key, "model_provider:");
    if (!sessionId) continue;
    persistedProviders.set(sessionId, value);
    sessionIds.add(sessionId);
  }
  for (const sessionId of Object.keys(selectedModels)) sessionIds.add(sessionId);
  for (const sessionId of Object.keys(selectedProviders)) sessionIds.add(sessionId);

  const sessionsToReset = [...sessionIds]
    .filter((sessionId) => {
      const model = persistedModels.get(sessionId) ?? selectedModels[sessionId] ?? null;
      const provider =
        persistedProviders.get(sessionId) ??
        selectedProviders[sessionId] ??
        DEFAULT_CLAUDE_BACKEND;
      return isAlternativeBackendSelection(model, provider);
    })
    .sort();

  return {
    defaultModel: nextDefaultModel,
    defaultBackend: DEFAULT_CLAUDE_BACKEND,
    resetDefault,
    sessionIds: sessionsToReset,
  };
}
