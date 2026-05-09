import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  generateWorkspaceName,
  createWorkspace,
  getRepoConfig,
  runWorkspaceSetup,
} from "../services/tauri";

/** Outcome surfaced to callers so they can show toasts or chain follow-up work
 *  without prying into the store. The hook still performs the core side-effects
 *  (addWorkspace, selectWorkspace, addChatMessage, openModal) on its own. */
export interface CreateWorkspaceOutcome {
  workspaceId: string;
  sessionId: string;
}

export interface UseCreateWorkspaceOptions {
  /** When the suggested action is "create a workspace and immediately open it",
   *  callers usually want the new workspace to be selected. The Sidebar already
   *  selects on click, so allow opting out from there. Defaults to true. */
  selectOnCreate?: boolean;
}

/** Encapsulates the orchestration that used to live inline in Sidebar.tsx:
 *
 *  1. Generate a workspace slug.
 *  2. Call the Tauri `createWorkspace` command (skipping setup so we can prompt).
 *  3. Push the new workspace into the store and (optionally) select it.
 *  4. Surface the slug-rename rationale as a system message in the new session.
 *  5. Either auto-run the setup script or prompt the user via the
 *     `confirmSetupScript` modal.
 *
 *  Returns a `create(repoId)` callback plus a `creating` boolean so the caller
 *  can disable its own UI while the call is in flight. The hook also exposes
 *  the in-flight `repoId` for callers that want to render a loading row scoped
 *  to that repo (the Sidebar's optimistic-row pattern).
 */
export function useCreateWorkspace(options: UseCreateWorkspaceOptions = {}) {
  const { selectOnCreate = true } = options;

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const openModal = useAppStore((s) => s.openModal);

  // Single-flight guard — duplicate clicks while a creation is in flight are
  // dropped silently. The ref lets us short-circuit before we even touch state.
  const inFlight = useRef(false);
  const [creatingRepoId, setCreatingRepoId] = useState<string | null>(null);

  const create = useCallback(
    async (repoId: string): Promise<CreateWorkspaceOutcome | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setCreatingRepoId(repoId);

      try {
        const generated = await generateWorkspaceName();
        const result = await createWorkspace(repoId, generated.slug, true);

        addWorkspace(result.workspace);
        if (selectOnCreate) selectWorkspace(result.workspace.id);

        const sessionId = result.default_session_id;
        if (generated.message) {
          addChatMessage(sessionId, {
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
              runWorkspaceSetup(wsId)
                .then((sr) => {
                  if (!sr) return;
                  const lbl = sr.source === "repo" ? ".claudette.json" : "settings";
                  const status = sr.success
                    ? "completed"
                    : sr.timed_out
                      ? "timed out"
                      : "failed";
                  addChatMessage(sessionId, {
                    id: crypto.randomUUID(),
                    workspace_id: wsId,
                    chat_session_id: sessionId,
                    role: "System",
                    content: `Setup script (${lbl}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
                    cost_usd: null,
                    duration_ms: null,
                    created_at: new Date().toISOString(),
                    thinking: null,
                    input_tokens: null,
                    output_tokens: null,
                    cache_read_tokens: null,
                    cache_creation_tokens: null,
                  });
                })
                .catch((err) => {
                  addChatMessage(sessionId, {
                    id: crypto.randomUUID(),
                    workspace_id: wsId,
                    chat_session_id: sessionId,
                    role: "System",
                    content: `Setup script failed: ${err}`,
                    cost_usd: null,
                    duration_ms: null,
                    created_at: new Date().toISOString(),
                    thinking: null,
                    input_tokens: null,
                    output_tokens: null,
                    cache_read_tokens: null,
                    cache_creation_tokens: null,
                  });
                });
            } else {
              openModal("confirmSetupScript", {
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
        setCreatingRepoId(null);
        inFlight.current = false;
      }
    },
    [addWorkspace, selectWorkspace, addChatMessage, openModal, selectOnCreate],
  );

  return {
    create,
    creating: creatingRepoId !== null,
    creatingRepoId,
  };
}
