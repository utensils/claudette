import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  generateWorkspaceName,
  createWorkspace,
  getRepoConfig,
  runWorkspaceSetup,
} from "../services/tauri";
import { runAndRecordSetupScript } from "../utils/setupScriptMessage";
import type { Workspace } from "../types/workspace";

/** Build the optimistic-placeholder Workspace inserted at the start
 *  of a create flow. The fields are best-effort approximations of
 *  what the backend will write — `name` matches the generated slug
 *  (which `createWorkspace` honors), and `branch_name` is left empty
 *  until the real row replaces this one. The placeholder id uses the
 *  `pending-create-` prefix so a glance at the store distinguishes
 *  the two pending-placeholder families ([`pendingCreates`] vs
 *  [`pendingForks`]) without consulting the side maps. */
function buildPlaceholderWorkspace(repoId: string, slug: string): Workspace {
  return {
    id: `pending-create-${crypto.randomUUID()}`,
    repository_id: repoId,
    name: slug,
    branch_name: "",
    worktree_path: null,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: new Date().toISOString(),
    // Float to the bottom of the repo's workspace list so the
    // placeholder doesn't shove the existing rows around. The real
    // row's `sort_order` from `db.list_workspaces` lands at the
    // correct position once `commitPendingCreate` swaps it in.
    sort_order: Number.MAX_SAFE_INTEGER,
    remote_connection_id: null,
  };
}

/** Detect the backend's "a create is already running for this repo"
 *  rejection (issue #896). `create_workspace` returns the bare error
 *  code `WORKSPACE_CREATE_IN_FLIGHT` across the Tauri IPC boundary — a
 *  fixed token rather than a human sentence, so this match can't
 *  silently break on a Rust-side wording tweak or future localization
 *  (mirrors the `WORKSPACE_FILE_NOT_FOUND` convention in
 *  `FileViewer.tsx`). The error reaching the catch block is typically a
 *  `string`, occasionally an `Error`, so normalize before comparing.
 *  Keep this code in sync with `WORKSPACE_CREATE_IN_FLIGHT_ERR` in
 *  `src-tauri/src/commands/workspace.rs`. */
function isCreateInFlightRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "WORKSPACE_CREATE_IN_FLIGHT";
}

/** Outcome surfaced to callers so they can show toasts or chain follow-up work
 *  without prying into the store. The orchestration still performs the core
 *  side-effects (addWorkspace, selectWorkspace, addChatMessage, openModal)
 *  on its own. */
export interface CreateWorkspaceOutcome {
  workspaceId: string;
  sessionId: string;
}

export interface CreateWorkspaceOptions {
  /** When the suggested action is "create a workspace and immediately open it",
   *  callers usually want the new workspace to be selected. The Sidebar already
   *  selects on click, so allow opting out from there. Defaults to true. */
  selectOnCreate?: boolean;
  /** Stable key for a user gesture that should only create one workspace.
   *  The default keeps manual "New workspace" clicks single-flight. Project
   *  issue/PR sends pass an item-specific key so distinct sends queue while
   *  an accidental re-fire of the same row still collapses to one create. */
  idempotencyKey?: string;
}

// Module-level queue/idempotency state. Lives outside the hook so the
// non-hook entry point (`createWorkspaceOrchestrated`, used by the
// Cmd+Shift+N hotkey) and the hook share the same duplicate protection.
// The queue keeps git/worktree creates sequential, while the key set keeps
// accidental re-fires of the same gesture from minting duplicates.
let createQueueTail: Promise<void> = Promise.resolve();
const createKeysInFlight = new Set<string>();

const DEFAULT_CREATE_IDEMPOTENCY_KEY = "manual-workspace-create";

/** @internal test helper: clears module-level queue state between tests. */
export function __resetCreateWorkspaceOrchestrationForTests(): void {
  createQueueTail = Promise.resolve();
  createKeysInFlight.clear();
}

/** Single-source-of-truth orchestration shared between the React hook
 *  and the keyboard-shortcut path. Mirrors the original Sidebar.tsx
 *  inline flow:
 *
 *  1. Generate a workspace slug.
 *  2. Call the Tauri `createWorkspace` command (skipping setup so we can prompt).
 *  3. Push the new workspace into the store and (optionally) select it.
 *  4. Surface the slug-rename rationale as a system message in the new session.
 *  5. Either auto-run the setup script or prompt the user via the
 *     `confirmSetupScript` modal.
 *
 *  Reads / writes the store via `useAppStore.getState()` so non-React
 *  callers (the hotkey dispatcher) can use the same code path without
 *  having to wire up a React component first. The React hook below is a
 *  thin wrapper that adds the local `creating` state for callers that
 *  want to disable a button while in flight.
 */
export async function createWorkspaceOrchestrated(
  repoId: string,
  options: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceOutcome | null> {
  const idempotencyKey =
    options.idempotencyKey ?? DEFAULT_CREATE_IDEMPOTENCY_KEY;
  if (createKeysInFlight.has(idempotencyKey)) return null;
  createKeysInFlight.add(idempotencyKey);

  const runAfterPrior = createQueueTail.then(
    () => runCreateWorkspaceOrchestrated(repoId, options),
    () => runCreateWorkspaceOrchestrated(repoId, options),
  );
  createQueueTail = runAfterPrior.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await runAfterPrior;
  } finally {
    createKeysInFlight.delete(idempotencyKey);
  }
}

async function runCreateWorkspaceOrchestrated(
  repoId: string,
  options: CreateWorkspaceOptions = {},
): Promise<CreateWorkspaceOutcome | null> {
  const { selectOnCreate = true } = options;
  const store = useAppStore.getState();
  // Selection in effect before this create runs. If a benign backend
  // in-flight rejection tears the optimistic placeholder back down
  // (issue #896), selection is restored to this rather than nulled —
  // nothing actually failed, so the user should land where they were
  // instead of being yanked to the dashboard.
  const priorSelectedWorkspaceId = store.selectedWorkspaceId;
  // Publish to the store so the sidebar's optimistic "preparing
  // workspace…" indicator row appears immediately, regardless of
  // which UI surface (sidebar +, welcome card, project view, hotkey)
  // triggered the creation. Cleared in `finally` below.
  //
  // This flag is the "we don't know the workspace yet" hint that
  // covers the brief window between the user click and
  // `generateWorkspaceName` returning. As soon as we have a slug we
  // switch to the placeholder-workspace pattern (see
  // `beginPendingCreate` below), which takes over the optimistic UI
  // and replaces this flag's sidebar row with the actual placeholder.
  store.setCreatingWorkspaceRepoId(repoId);

  // Placeholder is built once we have the slug — the slug becomes
  // the placeholder workspace's `name`, which the chat panel
  // displays in the "Preparing workspace…" placard.
  let placeholderId: string | null = null;
  try {
    const generated = await generateWorkspaceName();
    // Clear the pre-slug indicator the moment we have a slug, even on
    // the no-placeholder (`selectOnCreate: false`) path. Otherwise the
    // backend's early `workspaces-changed (Created)` emit lands the
    // real workspace row in the sidebar alongside the still-active
    // "Preparing workspace environment…" indicator — two rows visible
    // for the entire create window.
    useAppStore.getState().setCreatingWorkspaceRepoId(null);
    if (selectOnCreate) {
      const placeholder = buildPlaceholderWorkspace(repoId, generated.slug);
      placeholderId = placeholder.id;
      // Atomic in one set(): insert placeholder row, select it, seed
      // workspaceEnvironment to "preparing" so the sidebar row
      // lights up the spinner immediately. Replaces the
      // creatingWorkspaceRepoId-driven row above.
      useAppStore.getState().beginPendingCreate(placeholder);
      // Always expand the parent repo group so the placeholder
      // (and, post-commit, the real row) is visible. Without this
      // a user with the repo collapsed would land on the chat panel
      // for a workspace whose row is hidden.
      useAppStore.getState().expandRepo(repoId);
    }
    const result = await createWorkspace(repoId, generated.slug, true);

    // The Rust `Workspace` model doesn't serialize the UI-only
    // `remote_connection_id` field, so the IPC payload arrives with it
    // missing entirely. Stamp it as `null` (this is a local create by
    // definition — the WS server never returns through this path) so
    // downstream checks that strict-compare `=== null` (rather than
    // `!= null` or truthy) don't trip on `undefined`. Without this
    // stamp the env-prep hook treats the row as unhydrated and bails,
    // stranding the just-created workspace at `"preparing"`. Mirrors
    // the existing fork-path stamp in ChatPanel.
    const stamped = { ...result.workspace, remote_connection_id: null };

    const post = useAppStore.getState();
    if (placeholderId) {
      // Atomic placeholder→real swap. Migrates the seeded
      // workspaceEnvironment to the real id, dedupes against the row
      // that `workspaces-changed` may already have inserted, and moves
      // the selection.
      post.commitPendingCreate(placeholderId, stamped);
      placeholderId = null;
    } else {
      // selectOnCreate === false: orchestration was asked not to
      // navigate, so no placeholder was inserted. Mirror the old
      // non-optimistic flow.
      post.addWorkspace(stamped);
      post.expandRepo(repoId);
    }

    const sessionId = result.default_session_id;
    if (generated.message) {
      post.addChatMessage(sessionId, {
        id: crypto.randomUUID(),
        workspace_id: result.workspace.id,
        chat_session_id: sessionId,
        role: "System",
        content: generated.message,
        cost_usd: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        thinking: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
      });
    }

    // Setup script — auto-run if the repo opted in, otherwise prompt.
    try {
      const config = await getRepoConfig(repoId);
      const repo = useAppStore
        .getState()
        .repositories.find((r) => r.id === repoId);
      const script = config.setup_script ?? repo?.setup_script;
      const source = config.setup_script ? "repo" : "settings";
      if (script) {
        if (repo?.setup_script_auto_run) {
          const wsId = result.workspace.id;
          const store = useAppStore.getState();
          runAndRecordSetupScript({
            sessionId,
            workspaceId: wsId,
            source,
            run: () => runWorkspaceSetup(wsId),
            deps: {
              addChatMessage: store.addChatMessage,
              setRunningSetupScript: store.setRunningSetupScript,
              addToast: store.addToast,
              workspaceName: result.workspace.name,
            },
          });
        } else {
          useAppStore.getState().openModal("confirmSetupScript", {
            workspaceId: result.workspace.id,
            sessionId,
            repoId,
            script,
            source,
          });
        }
      }
    } catch {
      // No config or unreadable — nothing to prompt.
    }

    return { workspaceId: result.workspace.id, sessionId };
  } catch (e) {
    // A backend in-flight rejection is not a failure: the user (or a
    // webview reload) re-triggered a create that is already running for
    // this repo, and the backend correctly refused to mint a duplicate.
    // Handle it ahead of the error-level log and null-selection teardown
    // below — it is a benign outcome, so it must not surface in
    // logs/telemetry as a failure, and it should leave the user where
    // they were rather than yanking them to the dashboard. Tear the
    // placeholder down restoring the pre-create selection, surface a
    // calm toast, and return null — the same shape as the in-process
    // idempotency early-return. See issue #896.
    if (isCreateInFlightRejection(e)) {
      if (placeholderId) {
        useAppStore
          .getState()
          .cancelPendingCreate(placeholderId, priorSelectedWorkspaceId);
      }
      useAppStore
        .getState()
        .addToast(
          "A workspace is already being created for this repository. Please wait for it to finish.",
        );
      return null;
    }
    console.error("Failed to create workspace:", e);
    // Tear down the optimistic placeholder so the user isn't stranded
    // on a selected row that will never resolve. Restore selection to
    // null (we have no good fallback — the user clicked New, so
    // taking them back to whatever they had before would be confusing
    // too; null lands them on the dashboard which is the safest
    // recovery surface).
    if (placeholderId) {
      useAppStore.getState().cancelPendingCreate(placeholderId, null);
    }
    // Re-throw so the caller decides whether to alert / toast.
    throw e;
  } finally {
    useAppStore.getState().setCreatingWorkspaceRepoId(null);
  }
}

export type UseCreateWorkspaceOptions = Omit<
  CreateWorkspaceOptions,
  "idempotencyKey"
>;

/** React hook wrapping `createWorkspaceOrchestrated` with local React
 *  state so a button can disable itself while the call is in flight.
 *  Returns the same orchestration outcome plus a `creating` boolean and
 *  the in-flight `creatingRepoId` (mirrors the sidebar's optimistic-row
 *  pattern, though that row also reads from `creatingWorkspaceRepoId`
 *  in the store now). */
export function useCreateWorkspace(options: UseCreateWorkspaceOptions = {}) {
  const { selectOnCreate = true } = options;

  // Local mirror of the in-flight repoId for components that want to
  // disable their own button without subscribing to the store value.
  const inFlight = useRef(false);
  const [creatingRepoId, setCreatingRepoId] = useState<string | null>(null);

  const create = useCallback(
    async (repoId: string): Promise<CreateWorkspaceOutcome | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setCreatingRepoId(repoId);
      try {
        return await createWorkspaceOrchestrated(repoId, { selectOnCreate });
      } finally {
        setCreatingRepoId(null);
        inFlight.current = false;
      }
    },
    [selectOnCreate],
  );

  return {
    create,
    creating: creatingRepoId !== null,
    creatingRepoId,
  };
}
