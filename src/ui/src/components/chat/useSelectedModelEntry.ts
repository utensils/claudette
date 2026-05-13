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
  const experimentalCodexEnabled = useAppStore(
    (s) => s.experimentalCodexEnabled,
  );
  const agentBackends = useAppStore((s) => s.agentBackends);
  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends, experimentalCodexEnabled),
    [alternativeBackendsEnabled, agentBackends, experimentalCodexEnabled],
  );
  return findModelInRegistry(registry, selectedModel, selectedProvider);
}
