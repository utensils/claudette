/**
 * Open the `requiredInputs` modal for a repo and resolve with the values
 * the user submitted — or `null` if they cancelled (or the repo has no
 * declared schema, in which case the modal is skipped entirely).
 *
 * Lives outside the React tree so both the hook-based orchestrator
 * (`createWorkspaceOrchestrated`) and the Sidebar's own inline create flow
 * can share the same prompt. Without this, only one of those two paths
 * would prompt and the other would silently send no values, causing the
 * backend validator to reject the create with a "Missing value for
 * required input" error.
 */
import { useAppStore } from "../stores/useAppStore";
import type { RepositoryInputField } from "../types/repositoryInput";

export interface PromptResult {
  /** `null` ⇒ the user cancelled. `Record` ⇒ values to forward verbatim
   *  to `createWorkspace`. `undefined` ⇒ no prompt was needed (repo has
   *  no declared schema) — callers should pass `null` to the Tauri call. */
  values: Record<string, string> | null | undefined;
  /** `true` when this call opened a modal that's still visible to the user.
   *  The orchestrator owns closing it (either by `openModal(...)` to a
   *  replacement, or an explicit `closeModal()` when no follow-up modal
   *  appears). When `values` is `null` (cancel) the modal closed itself
   *  before resolving, so this is `false`. When `values` is `undefined`
   *  (no schema) no modal was opened at all, so this is also `false`. */
  modalStillOpen: boolean;
}

/** Returns `undefined` immediately when the repo declares no inputs, so the
 *  caller can distinguish "skipped" from "cancelled". */
export async function promptRequiredInputsIfDeclared(
  repoId: string,
): Promise<PromptResult> {
  const repo = useAppStore.getState().repositories.find((r) => r.id === repoId);
  const schema = repo?.required_inputs ?? null;
  if (!schema || schema.length === 0) {
    return { values: undefined, modalStillOpen: false };
  }
  const values = await new Promise<Record<string, string> | null>((resolve) => {
    useAppStore.getState().openModal("requiredInputs", {
      schema: schema satisfies RepositoryInputField[],
      repoName: repo?.name ?? "",
      resolve,
    });
  });
  // On submit, the modal calls `resolve` but leaves itself mounted so the
  // orchestrator can replace it atomically. On cancel, the modal calls
  // `closeModal()` itself before resolving with `null`.
  return { values, modalStillOpen: values !== null };
}
