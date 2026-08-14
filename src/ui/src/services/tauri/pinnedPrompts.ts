import { invoke } from "@tauri-apps/api/core";

/**
 * Tri-state toggle override on a pinned prompt:
 * - `null` means "inherit the session's current toolbar value when used"
 * - `true` / `false` forces the toolbar toggle to that value (sticky write)
 */
export type PinnedPromptToggleOverride = boolean | null;

export interface PinnedPrompt {
  id: number;
  repo_id: string | null;
  display_name: string;
  prompt: string;
  auto_send: boolean;
  plan_mode: PinnedPromptToggleOverride;
  fast_mode: PinnedPromptToggleOverride;
  thinking_enabled: PinnedPromptToggleOverride;
  chrome_enabled: PinnedPromptToggleOverride;
  /** Open a fresh chat tab in the current workspace and run the prompt
   *  there instead of in the active session. */
  new_session: boolean;
  /** Model to select before the prompt runs. `null` inherits whatever the
   *  target session already has. */
  model: string | null;
  /** Backend id qualifying `model` — model ids are only unique per backend.
   *  Always `null` when `model` is `null`. */
  model_provider: string | null;
  sort_order: number;
  created_at: string;
}

/** Returns the merged composer list: repo entries first, then non-shadowed globals. */
export function getPinnedPrompts(
  repoId: string | null,
): Promise<PinnedPrompt[]> {
  return invoke("get_pinned_prompts", { repoId });
}

/** Returns the prompts in a single scope (null = globals). */
export function listPinnedPromptsInScope(
  repoId: string | null,
): Promise<PinnedPrompt[]> {
  return invoke("list_pinned_prompts_in_scope", { repoId });
}

export interface PinnedPromptToggleOverrides {
  planMode: PinnedPromptToggleOverride;
  fastMode: PinnedPromptToggleOverride;
  thinkingEnabled: PinnedPromptToggleOverride;
  chromeEnabled: PinnedPromptToggleOverride;
}

/** Where a pinned prompt runs and on which model. Mirrors the Rust
 *  `PinnedPromptLaunch`; the backend normalizes blanks and drops a
 *  `model_provider` that has no `model` to qualify. */
export interface PinnedPromptLaunch {
  new_session: boolean;
  model: string | null;
  model_provider: string | null;
}

export const DEFAULT_PINNED_PROMPT_LAUNCH: PinnedPromptLaunch = {
  new_session: false,
  model: null,
  model_provider: null,
};

export function createPinnedPrompt(
  repoId: string | null,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
  launch: PinnedPromptLaunch = DEFAULT_PINNED_PROMPT_LAUNCH,
): Promise<PinnedPrompt> {
  return invoke("create_pinned_prompt", {
    repoId,
    displayName,
    prompt,
    autoSend,
    planMode: overrides.planMode,
    fastMode: overrides.fastMode,
    thinkingEnabled: overrides.thinkingEnabled,
    chromeEnabled: overrides.chromeEnabled,
    launch,
  });
}

export function updatePinnedPrompt(
  id: number,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
  launch: PinnedPromptLaunch = DEFAULT_PINNED_PROMPT_LAUNCH,
): Promise<PinnedPrompt> {
  return invoke("update_pinned_prompt", {
    id,
    displayName,
    prompt,
    autoSend,
    planMode: overrides.planMode,
    fastMode: overrides.fastMode,
    thinkingEnabled: overrides.thinkingEnabled,
    chromeEnabled: overrides.chromeEnabled,
    launch,
  });
}

export function deletePinnedPrompt(id: number): Promise<void> {
  return invoke("delete_pinned_prompt", { id });
}

export function reorderPinnedPrompts(
  repoId: string | null,
  ids: number[],
): Promise<void> {
  return invoke("reorder_pinned_prompts", { repoId, ids });
}
