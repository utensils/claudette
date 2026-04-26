import { useAppStore } from "../../stores/useAppStore";

/**
 * Apply the global `default_plan_mode` to a session only if the store has no
 * runtime value for that session yet. A remount mid-flow (session swap,
 * remote reconnect, HMR) must not clobber an agent-driven clear of plan mode.
 */
export function applyPlanModeMountDefault(
  sessionId: string,
  defaultValue: boolean,
): void {
  const store = useAppStore.getState();
  if (store.planMode[sessionId] === undefined) {
    store.setPlanMode(sessionId, defaultValue);
  }
}
