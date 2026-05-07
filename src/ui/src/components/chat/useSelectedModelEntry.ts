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
  const agentBackends = useAppStore((s) => s.agentBackends);
  const registry = buildModelRegistry(alternativeBackendsEnabled, agentBackends);
  return findModelInRegistry(registry, selectedModel, selectedProvider);
}
