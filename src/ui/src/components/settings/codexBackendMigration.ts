import { DEFAULT_CLAUDE_BACKEND, DEFAULT_CLAUDE_MODEL } from "./alternativeBackendCleanup";

export const LEGACY_CODEX_BACKEND = "codex-subscription";
export const NATIVE_CODEX_BACKEND = "experimental-codex";

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

export interface ExperimentalBackendGateLoadInput {
  alternativeBackendsCompiled: boolean;
  alternativeBackendsSetting: string | null;
  experimentalCodexSetting: string | null;
}

export interface ExperimentalBackendGateLoadPlan {
  alternativeBackendsEnabled: boolean;
  experimentalCodexEnabled: boolean;
  persistAlternativeBackendsEnabled: boolean;
}

function settingSessionId(key: string, prefix: string): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

export function planExperimentalBackendGateLoad({
  alternativeBackendsCompiled,
  alternativeBackendsSetting,
  experimentalCodexSetting,
}: ExperimentalBackendGateLoadInput): ExperimentalBackendGateLoadPlan {
  const experimentalCodexEnabled =
    alternativeBackendsCompiled && experimentalCodexSetting === "true";
  const alternativeBackendsEnabled =
    alternativeBackendsCompiled && alternativeBackendsSetting === "true";

  return {
    alternativeBackendsEnabled,
    experimentalCodexEnabled,
    persistAlternativeBackendsEnabled: false,
  };
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
