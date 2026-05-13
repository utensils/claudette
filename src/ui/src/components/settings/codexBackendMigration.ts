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
  defaultBackend: string | null;
  resetDefault: boolean;
  sessionIds: string[];
}

function settingSessionId(key: string, prefix: string): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

export function planCodexBackendGateMigration({
  enableNative,
  defaultBackend,
  sessionProviders,
  selectedProviders,
}: CodexBackendGateMigrationInput): CodexBackendGateMigrationPlan {
  const fromBackend = enableNative ? LEGACY_CODEX_BACKEND : NATIVE_CODEX_BACKEND;
  const toBackend = enableNative ? NATIVE_CODEX_BACKEND : LEGACY_CODEX_BACKEND;
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
    defaultBackend: defaultBackend === fromBackend ? toBackend : defaultBackend,
    resetDefault: defaultBackend === fromBackend,
    sessionIds: [...sessionIds].sort(),
  };
}
