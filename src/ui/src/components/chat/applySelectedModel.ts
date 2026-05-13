import { resetAgentSession, setAppSetting } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import {
  isEffortSupported,
  isFastSupported,
} from "./modelCapabilities";
import {
  buildModelRegistry,
  findModelInRegistry,
  is1mContextModel,
  get1mFallback,
} from "./modelRegistry";
import {
  normalizeReasoningLevel,
  reasoningVariantForModel,
} from "./reasoningControls";

/**
 * Apply a model change for a chat session.
 *
 * Owns the full switch protocol so the toolbar and the `/model` slash command
 * stay in lockstep: persist the new model, reset the agent session (model is
 * session-level), clear any pending agent question/plan approval, and drop
 * any per-session flags the new model doesn't support (fast mode, effort
 * tiers like xhigh/max).
 */
export async function applySelectedModel(
  sessionId: string,
  nextModel: string,
  nextProvider = "anthropic",
): Promise<void> {
  const store = useAppStore.getState();
  const model = store.disable1mContext && is1mContextModel(nextModel)
    ? get1mFallback(nextModel)
    : nextModel;
  store.setSelectedModel(sessionId, model, nextProvider);
  await setAppSetting(`model:${sessionId}`, model);
  await setAppSetting(`model_provider:${sessionId}`, nextProvider);
  await resetAgentSession(sessionId);
  store.clearAgentQuestion(sessionId);
  store.clearPlanApproval(sessionId);
  store.clearAgentApproval(sessionId);

  const registry = buildModelRegistry(
    store.alternativeBackendsEnabled,
    store.agentBackends,
    store.experimentalCodexEnabled,
  );
  const selectedEntry = findModelInRegistry(registry, model, nextProvider);
  const supportsFast = selectedEntry?.supportsFastMode ?? isFastSupported(model);
  const supportsEffort = selectedEntry?.supportsEffort ?? isEffortSupported(model);

  const prevFastMode = store.fastMode[sessionId] ?? false;
  if (prevFastMode && !supportsFast) {
    store.setFastMode(sessionId, false);
    await setAppSetting(`fast_mode:${sessionId}`, "false");
  }

  const prevEffort = store.effortLevel[sessionId] ?? "auto";
  if (!supportsEffort) {
    store.setEffortLevel(sessionId, "auto");
    await setAppSetting(`effort_level:${sessionId}`, "auto");
  } else {
    const variant = reasoningVariantForModel(selectedEntry);
    const normalizedEffort = normalizeReasoningLevel(prevEffort, model, variant);
    if (normalizedEffort !== prevEffort) {
      store.setEffortLevel(sessionId, normalizedEffort);
      await setAppSetting(`effort_level:${sessionId}`, normalizedEffort);
    }
  }
}
