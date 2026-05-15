import { useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { buildModelRegistry, type Model } from "./modelRegistry";

/**
 * Returns the chat-side model registry with all of Claudette's
 * cross-cutting visibility gates already applied:
 *
 * - `alternativeBackendsEnabled` / `codexEnabled` feature flags
 *   (always pulled from the store — no consumer should rebuild
 *   what `shouldExposeBackendModels` already encodes).
 * - The Claude OAuth Pi-anthropic filter — mirrors
 *   `ensure_anthropic_not_routed_through_pi_via_oauth` in
 *   `src-tauri/src/commands/agent_backends.rs`. The Rust resolver
 *   refuses Pi-routed `anthropic/*` and `claude/*` selections under
 *   an OAuth subscription token, so the picker, Settings dropdown,
 *   `/model` slash command, command palette, toolbars, and every
 *   other selector need the same set hidden.
 *
 * Wrapping `buildModelRegistry` in a hook bakes the filter into a
 * single source so a future React consumer can't accidentally call
 * the raw builder and re-expose blocked rows. Non-React callers
 * (e.g. `applySelectedModel` which reads via `useAppStore.getState()`)
 * still need to compute the flag themselves — see the same expression
 * in those files.
 */
export function useModelRegistry(): readonly Model[] {
  const alternativeBackendsEnabled = useAppStore(
    (s) => s.alternativeBackendsEnabled,
  );
  const codexEnabled = useAppStore((s) => s.codexEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const claudeAuthMethod = useAppStore((s) => s.claudeAuthMethod);
  const isClaudeOauthSubscriber = useMemo(
    () => claudeAuthMethod?.toLowerCase() === "oauth_token",
    [claudeAuthMethod],
  );
  return useMemo(
    () =>
      buildModelRegistry(
        alternativeBackendsEnabled,
        agentBackends,
        codexEnabled,
        { isClaudeOauthSubscriber },
      ),
    [
      alternativeBackendsEnabled,
      agentBackends,
      codexEnabled,
      isClaudeOauthSubscriber,
    ],
  );
}
