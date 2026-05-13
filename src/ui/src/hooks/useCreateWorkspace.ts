import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  generateWorkspaceName,
  createWorkspace,
  getRepoConfig,
  runWorkspaceSetup,
} from "../services/tauri";
import { runAndRecordSetupScript } from "../utils/setupScriptMessage";

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
}

// Module-level single-flight guard. Lives outside the hook so the
// non-hook entry point (`createWorkspaceOrchestrated`, used by the
// Cmd+Shift+N hotkey) and the hook share the same in-flight semaphore;
// otherwise a hotkey press while the welcome card's CTA is mid-flight
// could double-trigger the slug generator and produce two workspaces.
let creationInFlight = false;

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
  if (creationInFlight) return null;
  creationInFlight = true;
  const { selectOnCreate = true } = options;
  const store = useAppStore.getState();
  // Publish to the store so the sidebar's optimistic "preparing
  // workspace…" placeholder row appears immediately, regardless of
  // which UI surface (sidebar +, welcome card, project view, hotkey)
  // triggered the creation. Cleared in `finally` below.
  store.setCreatingWorkspaceRepoId(repoId);

  try {
    const generated = await generateWorkspaceName();
    const result = await createWorkspace(repoId, generated.slug, true);

    const post = useAppStore.getState();
    post.addWorkspace(result.workspace);
    // Always expand the parent repo group — leaving a freshly created
    // workspace hidden inside a collapsed repo (because the user
    // collapsed it earlier or hadn't expanded it yet) is disorienting.
    post.expandRepo(repoId);
    if (selectOnCreate) post.selectWorkspace(result.workspace.id);

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
              updateChatMessage: store.updateChatMessage,
              removeChatMessage: store.removeChatMessage,
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
    console.error("Failed to create workspace:", e);
    // Re-throw so the caller decides whether to alert / toast.
    throw e;
  } finally {
    useAppStore.getState().setCreatingWorkspaceRepoId(null);
    creationInFlight = false;
  }
}

export type UseCreateWorkspaceOptions = CreateWorkspaceOptions;

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
