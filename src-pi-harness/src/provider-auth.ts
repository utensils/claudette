// Provider auth IPC handlers for the Pi harness.
//
// Owns the four flows the Settings UI / `/login` need:
//
//   1. `list_providers`   — merge CURATED_PROVIDERS with live auth status
//                           from Pi's ModelRegistry. Used to render the
//                           Pi provider list in Settings and inside the
//                           `/login` picker modal.
//   2. `set_api_key`      — write an API-key credential to ~/.pi/agent/
//                           auth.json (Pi's AuthStorage). Used by the
//                           "shared with terminal pi" storage path.
//   3. `clear_api_key`    — remove a provider's auth.json entry.
//   4. `oauth_*`          — drive Pi's `AuthStorage.login()` device-code
//                           flow. Streams `oauth_challenge` events back
//                           to Claudette so the UI can render the
//                           verification URL / user code and forward
//                           onPrompt() inputs (e.g. GHES domain) back
//                           in via `oauth_input`.
//
// Kept separate from `main.ts` to avoid piling responsibility onto the
// already-large dispatch file. `main.ts` adds one dispatch line per
// message in `handle()`; everything below lives here.
//
// Storage policy:
//   - This module ONLY writes to Pi's auth.json (the "shared" path).
//   - The keychain-only / Claudette-private path is handled Rust-side:
//     Claudette stores the key in its own secret store and passes the
//     matching env var (e.g. `OPENROUTER_API_KEY`) into the harness
//     process env. Pi's getApiKey resolution order ("auth.json wins,
//     env var fallback") means the two paths don't fight: a key in
//     auth.json takes precedence over the env var for the same
//     provider, so users can re-enter a key under the other policy
//     without manual cleanup.

import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CURATED_PROVIDERS, DEFAULT_VISIBLE_COUNT, type CuratedProvider } from "./curated-providers.js";

export type SendFn = (message: Record<string, unknown>) => void;

interface PendingOAuth {
  /** Stable id we hand back in every event for this OAuth attempt; used
   *  by the UI to route `oauth_input` / `oauth_cancel` back to the
   *  right pending challenge if the user starts two flows. */
  challengeId: string;
  providerId: string;
  controller: AbortController;
  /** Pending `onPrompt` resolver, if we are currently waiting on user
   *  input. Set when Pi calls `onPrompt`, cleared when the UI sends
   *  `oauth_input`. */
  pendingPrompt?: (value: string) => void;
}

export interface ProviderAuthDeps {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  send: SendFn;
}

/** Active OAuth challenges, keyed by challengeId. Module-private so
 *  the HarnessState in `main.ts` doesn't have to know about OAuth
 *  internals. The harness only re-spawns on `start_session` reauth,
 *  not on auth dialogs, so the lifetime of this map matches the
 *  sidecar process. */
const pendingOAuth = new Map<string, PendingOAuth>();

export interface ProviderRow extends CuratedProvider {
  /** Pi's `AuthStatus.source`, or undefined when no credential exists. */
  authSource?: string;
  /** True when at least one credential path resolves (auth.json, env
   *  var, runtime override, or models.json). Mirrors
   *  `AuthStorage.hasAuth`. */
  configured: boolean;
  /** Convenience for the UI — number of models Pi exposes for this
   *  provider once it's configured. Comes from
   *  `ModelRegistry.getAll().filter(m => m.provider === id)`. */
  modelCount: number;
}

export interface ListProvidersResponse {
  defaultVisibleCount: number;
  providers: ProviderRow[];
}

export function listProviders(state: ProviderAuthDeps): ListProvidersResponse {
  // Refresh first so an auth.json mutation from a previous IPC call (or
  // from a terminal `pi` running in parallel) is reflected in the row
  // we return.
  state.modelRegistry.refresh();
  const available = new Set(
    state.modelRegistry.getAvailable().map((m) => m.provider ?? ""),
  );
  const all = state.modelRegistry.getAll();
  const providers: ProviderRow[] = CURATED_PROVIDERS.map((entry) => {
    const status = state.modelRegistry.getProviderAuthStatus(entry.id);
    const modelCount = all.reduce(
      (acc, m) => (m.provider === entry.id ? acc + 1 : acc),
      0,
    );
    // `configured` mirrors the gate `listAvailableModels` uses: a
    // provider is configured iff at least one of its models passes
    // `hasConfiguredAuth` (AuthStorage.hasAuth OR a models.json
    // provider request config with an apiKey). Using `authStorage.has`
    // alone misses models.json-only providers like a `!security ...`
    // command-backed anthropic key.
    return {
      ...entry,
      authSource: status.source,
      configured: available.has(entry.id),
      modelCount,
    };
  });
  return { defaultVisibleCount: DEFAULT_VISIBLE_COUNT, providers };
}

export function setApiKey(
  state: ProviderAuthDeps,
  providerId: string,
  key: string,
): void {
  if (!providerId) throw new Error("Missing providerId");
  if (!key || !key.trim()) throw new Error("API key is empty");
  // Pi's AuthStorage handles the file lock + 0600 perms internally.
  state.authStorage.set(providerId, { type: "api_key", key: key.trim() });
}

export function clearApiKey(
  state: ProviderAuthDeps,
  providerId: string,
): void {
  if (!providerId) throw new Error("Missing providerId");
  state.authStorage.remove(providerId);
}

export async function oauthStart(
  state: ProviderAuthDeps,
  providerId: string,
  challengeId: string,
): Promise<void> {
  if (!providerId) throw new Error("Missing providerId");
  if (!challengeId) throw new Error("Missing challengeId");
  if (pendingOAuth.has(challengeId)) {
    throw new Error(`OAuth challenge ${challengeId} already in flight`);
  }
  const pending: PendingOAuth = {
    challengeId,
    providerId,
    controller: new AbortController(),
  };
  pendingOAuth.set(challengeId, pending);
  try {
    await state.authStorage.login(providerId, {
      onAuth: ({ url, instructions }: { url: string; instructions?: string }) => {
        state.send({
          type: "oauth_challenge",
          challengeId,
          providerId,
          kind: "auth",
          url,
          instructions,
        });
      },
      onPrompt: ({
        message,
        placeholder,
        allowEmpty,
      }: { message: string; placeholder?: string; allowEmpty?: boolean }) => {
        // Pi's enterprise prompt resolves to the *value the user types*
        // — typically a GHES domain or an empty string for github.com.
        // Park the resolver here; `handleOAuthInput` below resumes it
        // when the UI sends `oauth_input`.
        return new Promise<string>((resolve, reject) => {
          pending.pendingPrompt = resolve;
          state.send({
            type: "oauth_challenge",
            challengeId,
            providerId,
            kind: "prompt",
            message,
            placeholder,
            allowEmpty: allowEmpty ?? false,
          });
          pending.controller.signal.addEventListener(
            "abort",
            () => {
              pending.pendingPrompt = undefined;
              reject(new Error("OAuth flow cancelled by user."));
            },
            { once: true },
          );
        });
      },
      onProgress: (message: string) => {
        state.send({
          type: "oauth_progress",
          challengeId,
          providerId,
          message,
        });
      },
      signal: pending.controller.signal,
    });
    state.send({
      type: "oauth_complete",
      challengeId,
      providerId,
      ok: true,
    });
  } catch (err) {
    state.send({
      type: "oauth_complete",
      challengeId,
      providerId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    pendingOAuth.delete(challengeId);
  }
}

export function handleOAuthInput(
  challengeId: string,
  value: string,
): void {
  if (!challengeId) throw new Error("Missing challengeId");
  const pending = pendingOAuth.get(challengeId);
  if (!pending) {
    throw new Error(`Unknown OAuth challenge id: ${challengeId}`);
  }
  const resolver = pending.pendingPrompt;
  if (!resolver) {
    throw new Error(
      `OAuth challenge ${challengeId} is not currently awaiting input`,
    );
  }
  pending.pendingPrompt = undefined;
  resolver(value);
}

export function cancelOAuth(challengeId: string): void {
  if (!challengeId) throw new Error("Missing challengeId");
  const pending = pendingOAuth.get(challengeId);
  if (!pending) return;
  pending.controller.abort();
}
