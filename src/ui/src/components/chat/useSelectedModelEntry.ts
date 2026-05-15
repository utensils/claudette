import { useAppStore } from "../../stores/useAppStore";
import { findModelInRegistry, type Model } from "./modelRegistry";
import { useModelRegistry } from "./useModelRegistry";

export function useSelectedModelEntry(sessionId: string): Model | undefined {
  const selectedModel = useAppStore((s) => s.selectedModel[sessionId]);
  const selectedProvider = useAppStore(
    (s) => s.selectedModelProvider[sessionId] ?? "anthropic",
  );
  // Reusing `useModelRegistry` makes a previously-saved Pi/anthropic
  // selection resolve to `undefined` once the CLI logs in via OAuth —
  // the toolbar then falls back to its blank-state instead of
  // displaying a row the resolver would refuse to send.
  const registry = useModelRegistry();
  return findModelInRegistry(registry, selectedModel, selectedProvider);
}
