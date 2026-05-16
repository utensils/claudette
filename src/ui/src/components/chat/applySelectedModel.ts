import {
  prepareCrossHarnessMigration,
  resetAgentSession,
  setAppSetting,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import {
  isEffortSupported,
  isFastSupported,
} from "./modelCapabilities";
import {
  buildModelRegistry,
  findModelInRegistry,
  getHarnessForModel,
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
 * stay in lockstep: persist the new model, clear any pending agent
 * question/plan approval, and drop any per-session flags the new model
 * doesn't support (fast mode, effort tiers like xhigh/max).
 *
 * Session-handling rule, by swap kind:
 *
 * - **Same harness** (e.g. Sonnet 4.6 <-> Opus 4.7 on the Anthropic Claude
 *   Code path, or two Pi-routed Ollama models): preserve
 *   `chat_sessions.session_id` so the next turn resumes the prior
 *   transcript via `claude --resume` (Claude CLI) or its harness-native
 *   analogue. The Rust drift-detection in `src-tauri/src/commands/chat/
 *   send.rs` then respawns the persistent subprocess with the new
 *   `--model` while reusing the existing session id. Earlier code reset
 *   on every model change, which is what caused the "switching models
 *   loses context" regression.
 *
 * - **Cross harness** (e.g. Anthropic Claude Code -> Codex app-server,
 *   Codex -> Pi SDK): the destination harness can't read the source's
 *   transcript, so the session_id can't carry over. We call
 *   `prepare_cross_harness_migration` which mints a fresh session id,
 *   tears down the prior subprocess, and queues a synthetic prelude
 *   built from this session's `chat_messages` rows. The next user turn
 *   ships with that prelude prepended to its content (invisible to the
 *   UI, visible to the new harness as part of turn 1), so the
 *   conversation continues without context loss. If the prepare call
 *   fails, we fall back to `resetAgentSession` so the session at least
 *   restarts cleanly on the new harness — same behaviour as before
 *   Phase 2, just without the prelude.
 *
 * - **First-time selection** (no prior model recorded): no reset and
 *   no migration — the session has no transcript to preserve yet.
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

  // Match every other registry consumer's OAuth Pi-anthropic gate.
  // Without this the `/model` slash command can `findModelInRegistry`
  // a Pi/anthropic row (and thus read its capabilities) for an OAuth
  // subscriber whose resolver will refuse the send a moment later.
  const isClaudeOauthSubscriber =
    store.claudeAuthMethod?.toLowerCase() === "oauth_token";
  const registry = buildModelRegistry(
    store.alternativeBackendsEnabled,
    store.agentBackends,
    store.codexEnabled,
    { isClaudeOauthSubscriber, piSdkAvailable: store.piSdkAvailable },
  );

  const prevModel = store.selectedModel[sessionId];
  const prevProvider = store.selectedModelProvider[sessionId];
  const prevHarness = prevModel
    ? getHarnessForModel(registry, prevModel, prevProvider)
    : undefined;
  const nextHarness = getHarnessForModel(registry, model, nextProvider);
  // A reset is required only when (a) there was a prior selection, and
  // (b) the resolved harness is changing. First-time selection and
  // same-harness swaps both reuse the existing session id. When either
  // harness is unknown (model not in the registry) be conservative and
  // skip the reset — a wiped transcript is the worse failure mode than
  // a stale persistent subprocess that the drift detector will respawn
  // on the next send anyway.
  const harnessChanged =
    !!prevHarness && !!nextHarness && prevHarness !== nextHarness;

  store.setSelectedModel(sessionId, model, nextProvider);
  await setAppSetting(`model:${sessionId}`, model);
  await setAppSetting(`model_provider:${sessionId}`, nextProvider);
  if (harnessChanged) {
    // Try the context-preserving migration first; fall back to a
    // hard reset if the Rust side rejects it (DB lookup failure,
    // missing chat session row, etc.). The fallback matches the
    // pre-Phase-2 behaviour — the user picks the new harness and
    // starts a fresh conversation there — which is strictly better
    // than leaving the session in an inconsistent state.
    try {
      await prepareCrossHarnessMigration(sessionId);
    } catch {
      await resetAgentSession(sessionId);
    }
  }
  store.clearAgentQuestion(sessionId);
  store.clearPlanApproval(sessionId);
  store.clearAgentApproval(sessionId);

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
