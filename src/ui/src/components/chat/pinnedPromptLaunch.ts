/**
 * Applying a pinned prompt's launch options — its target session and model —
 * on top of the tri-state toolbar overrides it already carried.
 *
 * Two ordering rules are load-bearing, and are the reason this lives in its
 * own module rather than inline in `ChatInputArea`:
 *
 * 1. **Overrides before model.** `applySelectedModel` prunes per-session
 *    flags the chosen model can't support (fast mode, xhigh/max effort) by
 *    reading them back out of the store. Applying the pin's overrides first
 *    means a `fast_mode: true` override on a model without fast-mode support
 *    gets correctly pruned instead of sticking as an impossible state.
 *
 * 2. **Persist before switching tabs.** `ComposerToolbar`'s mount effect
 *    re-reads `fast_mode:` / `thinking_enabled:` / `chrome_enabled:` /
 *    `effort_level:` from app settings whenever its `sessionId` changes and
 *    writes them into the store *unconditionally*. A new-tab launch that only
 *    set store values would have them silently clobbered a tick later. So the
 *    new-session path persists first and lets the mount-load read our values
 *    back. (`plan_mode` is already safe — `applyPlanModeMountDefault` bails
 *    when the store holds a value — but it's persisted alongside the rest for
 *    consistency and restart durability.)
 */

import {
  createChatSession,
  renameChatSession,
  setAppSetting,
  type PinnedPrompt,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { applySelectedModel } from "./applySelectedModel";
import { buildModelRegistry, findModelInRegistry } from "./modelRegistry";
import { setPlanModeAndPersist } from "./planModePersistence";

/** A pin's model, resolved to ids the chat model-switch path accepts. */
export interface ResolvedPinnedPromptModel {
  model: string;
  provider: string;
}

/**
 * Resolve a pin's stored model against the live registry.
 *
 * Returns `null` when the pin doesn't name a model, or when it names one
 * that is no longer visible — the backend was disabled, dropped from a
 * provider manifest, or gated off by an OAuth change. Falling back to the
 * session's own model beats hard-failing the click: the user still gets
 * their prompt, just on the default model. The settings UI surfaces the
 * same staleness as a badge so the pin can be repaired.
 */
export function resolvePinnedPromptModel(
  pin: Pick<PinnedPrompt, "model" | "model_provider">,
): ResolvedPinnedPromptModel | null {
  if (!pin.model) return null;
  const store = useAppStore.getState();
  const registry = buildModelRegistry(
    store.alternativeBackendsEnabled,
    store.agentBackends,
    store.codexEnabled,
  );
  const provider = pin.model_provider ?? "anthropic";
  const entry = findModelInRegistry(registry, pin.model, provider);
  if (!entry) return null;
  return { model: entry.id, provider: entry.providerId ?? "anthropic" };
}

/**
 * Tri-state toggles whose `PinnedPrompt` field name matches their
 * per-session app-setting prefix (`fast_mode` -> `fast_mode:<sessionId>`).
 *
 * `plan_mode` is deliberately absent: it routes through
 * `setPlanModeAndPersist` so the "turning plan mode off also clears a
 * pending plan approval" invariant stays in one place.
 */
const DIRECT_TOGGLE_FIELDS = [
  "fast_mode",
  "thinking_enabled",
  "chrome_enabled",
] as const;

/**
 * Write the pin's forced toggles into the store for `sessionId`.
 *
 * `null` overrides are skipped — they mean "inherit whatever this session
 * already has", which for a brand-new session is its configured defaults.
 */
function applyToggleOverridesToStore(sessionId: string, pin: PinnedPrompt): void {
  const store = useAppStore.getState();
  if (pin.plan_mode !== null) void setPlanModeAndPersist(sessionId, pin.plan_mode);
  if (pin.fast_mode !== null) store.setFastMode(sessionId, pin.fast_mode);
  if (pin.thinking_enabled !== null)
    store.setThinkingEnabled(sessionId, pin.thinking_enabled);
  if (pin.chrome_enabled !== null)
    store.setChromeEnabled(sessionId, pin.chrome_enabled);
}

/**
 * Persist the pin's forced toggles as app settings for `sessionId`.
 *
 * Only used on the new-session path — see rule 2 in the module docs. The
 * active-session path deliberately stays store-only, matching the
 * pre-existing "sticky for this app run" semantics of toolbar overrides.
 *
 * `plan_mode` is not written here: `applyToggleOverridesToStore` runs right
 * after and persists it via `setPlanModeAndPersist`. Writing it in both
 * places would fire two `app_settings` writes for one launch.
 *
 * Best-effort by design. This runs *after* `createChatSession` has already
 * committed a row, so letting a failed write reject would abandon a tab
 * that exists in the database but was never named, added to the store, or
 * selected. A launched tab with one stale toolbar toggle is a far better
 * outcome than an orphaned session, and the toggle is still visible and
 * fixable in the composer.
 */
async function persistToggleOverrides(
  sessionId: string,
  pin: PinnedPrompt,
): Promise<void> {
  const writes: Promise<unknown>[] = [];
  for (const field of DIRECT_TOGGLE_FIELDS) {
    const value = pin[field];
    if (value === null) continue;
    writes.push(
      setAppSetting(`${field}:${sessionId}`, String(value)).catch((err) =>
        console.error(`[pinned-prompt] Failed to persist ${field}:${sessionId}`, err),
      ),
    );
  }
  await Promise.all(writes);
}

export interface PinnedPromptLaunchContext {
  workspaceId: string;
  /** Session the pill was clicked from — the target unless `new_session`. */
  sessionId: string;
}

export interface PinnedPromptLaunchResult {
  /** Session the prompt should run in. */
  sessionId: string;
  /** True when a fresh tab was opened for this launch. */
  openedNewSession: boolean;
}

/**
 * Prepare the target session for a pinned prompt and return where it should run.
 *
 * For a pin without `new_session` this is the pre-existing behaviour: apply
 * toolbar overrides (and now the model) to the active session in place. The
 * caller then sends as usual.
 *
 * For a pin with `new_session` this creates a tab, configures it, names it
 * after the pin, and selects it. The caller enqueues the prompt through
 * `enqueueChatPrompt` rather than calling `onSend` directly, because
 * `ChatPanel.handleSend` is bound to whichever session is currently active
 * and the new one isn't mounted yet.
 *
 * Throws only if the session could not be created; every other step
 * degrades (an unresolvable model falls back to the session default, a
 * failed rename leaves the auto-generated name).
 */
export async function preparePinnedPromptTarget(
  pin: PinnedPrompt,
  ctx: PinnedPromptLaunchContext,
): Promise<PinnedPromptLaunchResult> {
  const resolvedModel = resolvePinnedPromptModel(pin);

  if (!pin.new_session) {
    applyToggleOverridesToStore(ctx.sessionId, pin);
    if (resolvedModel) {
      // Same-harness swaps keep the transcript; cross-harness swaps mint a
      // fresh session id and seed a prelude. Both are `applySelectedModel`'s
      // job — identical to what the `/model` slash command does.
      await applySelectedModel(
        ctx.sessionId,
        resolvedModel.model,
        resolvedModel.provider,
      );
    }
    return { sessionId: ctx.sessionId, openedNewSession: false };
  }

  const session = await createChatSession(ctx.workspaceId);
  const store = useAppStore.getState();

  // Persist first (rule 2), then mirror into the store so there's no
  // one-frame flash of default toolbar state before the mount-load lands.
  await persistToggleOverrides(session.id, pin);
  applyToggleOverridesToStore(session.id, pin);

  if (resolvedModel) {
    // A brand-new session has no prior model recorded, so this is a
    // first-time selection: `applySelectedModel` skips both the reset and
    // the cross-harness migration prelude. Picking Codex here is free.
    await applySelectedModel(
      session.id,
      resolvedModel.model,
      resolvedModel.provider,
    );
  }

  // Name the tab after the pin so a review tab is identifiable at a glance.
  // This sets `name_edited`, which suppresses the agent's auto-naming for
  // this session — an intentional trade: an explicitly-launched tab already
  // has a name the user chose.
  let name = session.name;
  let nameEdited = session.name_edited;
  try {
    await renameChatSession(session.id, pin.display_name);
    name = pin.display_name;
    nameEdited = true;
  } catch (err) {
    console.error("[pinned-prompt] Failed to name the launched session:", err);
  }

  store.addChatSession({ ...session, name, name_edited: nameEdited });
  // Mirrors `SessionTabs.switchToSession`: an open file tab takes visual
  // priority over chat, so it has to be cleared for the new tab to show.
  store.clearActiveFileTab(ctx.workspaceId);
  store.selectSession(ctx.workspaceId, session.id);

  return { sessionId: session.id, openedNewSession: true };
}
