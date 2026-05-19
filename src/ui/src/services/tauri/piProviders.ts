// TypeScript bindings for the Pi provider-auth Tauri commands.
//
// Kept separate from `agentBackends.ts` so the new surface (six
// commands + an event channel) doesn't bloat the existing file. The
// `Event` listener pairs with `pi_oauth_start` to drive the device-code
// modal — subscribe BEFORE calling `pi_oauth_start` or the very first
// challenge event can race past you.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PiProviderKind = "api_key" | "oauth" | "oauth+enterprise" | "env_only";

export interface PiProvider {
  id: string;
  label: string;
  description: string;
  kind: PiProviderKind;
  envHint?: string;
  docsUrl?: string;
  /** Pi `AuthStatus.source` when present: `"stored"`, `"environment"`,
   *  `"runtime"`, `"fallback"`, `"models_json_key"`,
   *  `"models_json_command"`. Undefined when no credential resolves. */
  authSource?: string;
  /** `true` iff at least one of this provider's models would be
   *  returned by Pi's `getAvailable()`. Matches the gate used by
   *  `discover_models`, so a `configured: true` row means models will
   *  show up after the next refresh. */
  configured: boolean;
  modelCount: number;
}

export interface PiProviderList {
  defaultVisibleCount: number;
  providers: PiProvider[];
}

export type PiProviderSecretScope = "shared" | "local";

export interface PiOAuthStarted {
  challengeId: string;
  providerId: string;
}

export interface PiOpenRouterCredits {
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
}

export type PiOAuthEvent =
  | {
      type: "oauth_challenge";
      challengeId: string;
      providerId: string;
      /** `"auth"` → display URL + instructions; `"prompt"` → display
       *  `message` and a text input (e.g. GHES enterprise domain). */
      kind: "auth" | "prompt";
      url?: string | null;
      instructions?: string | null;
      message?: string | null;
      placeholder?: string | null;
      allowEmpty?: boolean;
    }
  | {
      type: "oauth_progress";
      challengeId: string;
      providerId: string;
      message: string;
    }
  | {
      type: "oauth_complete";
      challengeId: string;
      providerId: string;
      ok: boolean;
      error?: string | null;
    };

export const PI_OAUTH_EVENT_CHANNEL = "pi://oauth/event";

/** Query Pi for the curated provider list joined with live auth state.
 *  `workingDir` is used so a workspace-scoped Pi auth (rare) is
 *  reflected, but the call works with an empty string too. */
export function piListProviders(workingDir: string): Promise<PiProviderList> {
  return invoke("pi_list_providers", { workingDir });
}

export function piSetProviderApiKey(args: {
  workingDir: string;
  providerId: string;
  key: string;
  scope: PiProviderSecretScope;
}): Promise<void> {
  return invoke("pi_set_provider_api_key", args);
}

export function piClearProviderApiKey(args: {
  workingDir: string;
  providerId: string;
  scope: PiProviderSecretScope;
}): Promise<void> {
  return invoke("pi_clear_provider_api_key", args);
}

export function piOAuthStart(args: {
  workingDir: string;
  providerId: string;
}): Promise<PiOAuthStarted> {
  return invoke("pi_oauth_start", args);
}

export function piOAuthSubmitInput(args: {
  challengeId: string;
  value: string;
}): Promise<void> {
  return invoke("pi_oauth_submit_input", args);
}

export function piOAuthCancel(challengeId: string): Promise<void> {
  return invoke("pi_oauth_cancel", { challengeId });
}

export function piOpenRouterCredits(): Promise<PiOpenRouterCredits> {
  return invoke("pi_openrouter_credits");
}

/** Subscribe to the OAuth event stream. Returns an unlisten fn that
 *  the caller must invoke on unmount; otherwise the listener leaks
 *  across modal opens. */
export function listenPiOAuthEvents(
  handler: (event: PiOAuthEvent) => void,
): Promise<UnlistenFn> {
  return listen<PiOAuthEvent>(PI_OAUTH_EVENT_CHANNEL, (e) => handler(e.payload));
}
