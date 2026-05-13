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

export function createPinnedPrompt(
  repoId: string | null,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
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
  });
}

export function updatePinnedPrompt(
  id: number,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
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
