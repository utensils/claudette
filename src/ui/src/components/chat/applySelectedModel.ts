import { resetAgentSession, setAppSetting } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import {
  isEffortSupported,
  isFastSupported,
  isMaxEffortAllowed,
  isXhighEffortAllowed,
} from "./modelCapabilities";

/**
 * Apply a model change for a workspace.
 *
 * Owns the full switch protocol so the toolbar and the `/model` slash command
 * stay in lockstep: persist the new model, reset the agent session (model is
 * session-level), clear any pending agent question/plan approval, and drop
 * any per-workspace flags the new model doesn't support (fast mode, effort
 * tiers like xhigh/max).
 *
 * Safe to call even when the model is unchanged; callers should short-circuit
 * earlier if they want the no-op to skip the session reset.
 */
export async function applySelectedModel(
  workspaceId: string,
  nextModel: string,
): Promise<void> {
  const store = useAppStore.getState();
  store.setSelectedModel(workspaceId, nextModel);
  await setAppSetting(`model:${workspaceId}`, nextModel);
  await resetAgentSession(workspaceId);
  store.clearAgentQuestion(workspaceId);
  store.clearPlanApproval(workspaceId);

  const prevFastMode = store.fastMode[workspaceId] ?? false;
  if (prevFastMode && !isFastSupported(nextModel)) {
    store.setFastMode(workspaceId, false);
    await setAppSetting(`fast_mode:${workspaceId}`, "false");
  }

  const prevEffort = store.effortLevel[workspaceId] ?? "auto";
  if (!isEffortSupported(nextModel)) {
    store.setEffortLevel(workspaceId, "auto");
    await setAppSetting(`effort_level:${workspaceId}`, "auto");
  } else if (prevEffort === "xhigh" && !isXhighEffortAllowed(nextModel)) {
    store.setEffortLevel(workspaceId, "high");
    await setAppSetting(`effort_level:${workspaceId}`, "high");
  } else if (prevEffort === "max" && !isMaxEffortAllowed(nextModel)) {
    store.setEffortLevel(workspaceId, "high");
    await setAppSetting(`effort_level:${workspaceId}`, "high");
  }
}
