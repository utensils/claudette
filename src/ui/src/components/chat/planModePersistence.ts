import { useAppStore } from "../../stores/useAppStore";
import { setAppSetting } from "../../services/tauri";

/**
 * Mirrors how `fast_mode` / `thinking_enabled` are handled by their toolbar
 * toggles: update the in-memory store and persist the same value as
 * `plan_mode:${sessionId}` in `app_settings`. Use this at every user- or
 * agent-driven plan-mode toggle site so the off-state survives restart and
 * session swap.
 *
 * Persistence is best-effort: the in-memory store update is what the user
 * sees, so a failing `app_settings` write must not abort the surrounding
 * workflow (e.g. plan-approval handlers that chain `await onSend(...)`
 * after toggling plan mode) or surface as an unhandled rejection at the
 * many `void`-ed fire-and-forget call sites.
 */
export async function setPlanModeAndPersist(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  useAppStore.getState().setPlanMode(sessionId, enabled);
  try {
    await setAppSetting(`plan_mode:${sessionId}`, String(enabled));
  } catch (err) {
    console.error(`Failed to persist plan_mode:${sessionId}`, err);
  }
}

/**
 * Apply a plan-mode value to a session on first mount only — never clobber a
 * runtime value already present in the store. A remount mid-flow (session
 * swap, remote reconnect, HMR) must not overwrite an agent-driven
 * `ExitPlanMode` that already cleared plan mode for this run.
 *
 * Precedence when the store has no value yet:
 *   1. `persistedValue` (the `plan_mode:${sessionId}` row) — the user's last
 *      explicit choice on this session.
 *   2. `defaultValue` — the global `default_plan_mode` setting.
 */
export function applyPlanModeMountDefault(
  sessionId: string,
  persistedValue: string | null,
  defaultValue: boolean,
): void {
  const store = useAppStore.getState();
  if (store.planMode[sessionId] !== undefined) return;
  const next = persistedValue !== null ? persistedValue === "true" : defaultValue;
  store.setPlanMode(sessionId, next);
}
