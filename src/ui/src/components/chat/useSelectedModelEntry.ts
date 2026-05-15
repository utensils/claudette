import { useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { buildModelRegistry, findModelInRegistry, type Model } from "./modelRegistry";

export function useSelectedModelEntry(sessionId: string): Model | undefined {
  const selectedModel = useAppStore((s) => s.selectedModel[sessionId]);
  const selectedProvider = useAppStore(
    (s) => s.selectedModelProvider[sessionId] ?? "anthropic",
  );
  const alternativeBackendsEnabled = useAppStore(
    (s) => s.alternativeBackendsEnabled,
  );
  const codexEnabled = useAppStore(
    (s) => s.codexEnabled,
  );
  const agentBackends = useAppStore((s) => s.agentBackends);
  const claudeAuthMethod = useAppStore((s) => s.claudeAuthMethod);
  // Stamp the same OAuth Pi-anthropic gate every consumer uses so a
  // previously-saved Pi/anthropic selection resolves to `undefined`
  // here once the CLI logs in via OAuth — preventing the toolbar from
  // displaying a model the resolver would refuse to send.
  const isClaudeOauthSubscriber = useMemo(
    () => claudeAuthMethod?.toLowerCase() === "oauth_token",
    [claudeAuthMethod],
  );
  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends, codexEnabled, {
      isClaudeOauthSubscriber,
    }),
    [alternativeBackendsEnabled, agentBackends, codexEnabled, isClaudeOauthSubscriber],
  );
  return findModelInRegistry(registry, selectedModel, selectedProvider);
}
