import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { prepareWorkspaceEnvironment } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";

/**
 * Phase + payload shape mirroring `WorkspaceEnvProgressPayload` in
 * `src-tauri/src/commands/env.rs`. The Rust side broadcasts these
 * for **every** env-resolve call site (workspace creation, selection,
 * agent spawn, PTY spawn, env-panel reload), so this listener has to
 * handle progress for workspaces other than the currently selected one.
 *
 * `complete` fires once at the end of every resolve (via Drop on the
 * sink in Rust) and is the authoritative "all plugins are done"
 * signal — see the long comment over `Drop for TauriEnvProgressSink`
 * for the Windows IPC race it defends against.
 */
type EnvProgressPhase = "started" | "finished" | "complete";
interface WorkspaceEnvProgressPayload {
  workspace_id: string;
  plugin: string;
  phase: EnvProgressPhase;
  elapsed_ms: number;
  ok?: boolean;
}

export function useWorkspaceEnvironmentPreparation() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedWorkspaceRemoteConnectionId = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return null;
    const selectedWorkspace = s.workspaces.find(
      (w) => w.id === s.selectedWorkspaceId,
    );
    return selectedWorkspace?.remote_connection_id;
  });
  const setWorkspaceEnvironment = useAppStore((s) => s.setWorkspaceEnvironment);
  const setWorkspaceEnvironmentProgress = useAppStore(
    (s) => s.setWorkspaceEnvironmentProgress,
  );
  const addToast = useAppStore((s) => s.addToast);

  // Per-workspace flag: did any plugin emit `finished { ok: false }`
  // during the current resolve? Used by the Complete handler to
  // decide between transitioning to "ready" (clean resolve) vs
  // "error" (something failed). Without this, a backend prep that
  // returned Err whose Tauri response was dropped by the WebView2
  // IPC bridge would still get silently marked "ready" — hiding
  // trust errors and provider failures from the user. Cleared on
  // each Complete so a subsequent resolve starts fresh.
  const failedDuringResolveRef = useRef<Map<string, boolean>>(new Map());

  // Global listener: subscribe once per app session and route every
  // workspace_env_progress event into the store, regardless of which
  // workspace is currently selected. This lets the sidebar show a
  // "loading env-direnv (12s)…" spinner on row B while the user is
  // viewing workspace A, and the terminal/chat composer on every
  // open panel see the same updates without each having to listen.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const failed = failedDuringResolveRef.current;
    listen<WorkspaceEnvProgressPayload>("workspace_env_progress", (event) => {
      if (!mounted) return;
      const { workspace_id, plugin, phase, ok } = event.payload;
      if (phase === "started") {
        setWorkspaceEnvironmentProgress(workspace_id, plugin);
      } else if (phase === "finished") {
        setWorkspaceEnvironmentProgress(workspace_id, null);
        // Track per-plugin failures so the Complete handler below
        // can distinguish "all plugins succeeded — safe to mark
        // ready" from "something failed — mark error so a dropped
        // Tauri Err response doesn't silently paper over a trust
        // error or provider failure".
        if (ok === false) {
          failed.set(workspace_id, true);
        }
      } else {
        // phase === "complete" — fires once at end of every backend
        // resolve. Clear the active-plugin display and, critically,
        // transition any workspace stuck at "preparing" purely from
        // the progress-driven status bumps back to "ready" (or
        // "error" if any plugin reported failure). This recovers
        // the spawn_pty / agent-spawn paths where no dedicated
        // `.then` handler exists to finalize the status.
        setWorkspaceEnvironmentProgress(workspace_id, null);
        const anyFailed = failed.get(workspace_id) ?? false;
        failed.delete(workspace_id);
        const cur =
          useAppStore.getState().workspaceEnvironment[workspace_id]?.status;
        if (cur === "preparing") {
          if (anyFailed) {
            // The progress events don't carry the per-plugin error
            // text (only `ok: boolean`), so we can't reproduce the
            // detailed message the prep `.catch` would have shown.
            // A generic error pointing the user at the env panel is
            // strictly better than silently marking "ready" and
            // leaving them to discover the failure on the next
            // agent spawn.
            useAppStore
              .getState()
              .setWorkspaceEnvironment(
                workspace_id,
                "error",
                "Environment provider reported errors during resolve. See Repo Settings → Environment for per-plugin details.",
              );
          } else {
            useAppStore
              .getState()
              .setWorkspaceEnvironment(workspace_id, "ready");
          }
        }
      }
    }).then((stop) => {
      if (!mounted) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [setWorkspaceEnvironmentProgress]);

  // Per-selection prepare: when the user activates a local workspace,
  // kick off `prepare_workspace_environment` so the chat composer +
  // any opened terminal can wait on a definite "ready" signal. Remote
  // workspaces skip this — their env is resolved on the remote.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (selectedWorkspaceRemoteConnectionId === undefined) return;
    if (selectedWorkspaceRemoteConnectionId) {
      setWorkspaceEnvironment(selectedWorkspaceId, "ready");
      return;
    }

    const workspaceId = selectedWorkspaceId;
    let cancelled = false;
    setWorkspaceEnvironment(workspaceId, "preparing");

    // The recovery path for a dropped Tauri response on Windows
    // lives in the progress listener above: the `Complete` phase
    // (emitted by Drop on the Rust-side sink) transitions any
    // workspace stuck at "preparing" purely from progress events
    // back to "ready". So this `.then` is no longer load-bearing
    // for unlock — it's just the authoritative success update
    // when the IPC response does make it back. `.catch` still
    // respects `cancelled` so navigating away mid-flight doesn't
    // surface a stale toast for a workspace the user already left.
    prepareWorkspaceEnvironment(workspaceId)
      .then(() => {
        if (cancelled) return;
        setWorkspaceEnvironment(workspaceId, "ready");
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        setWorkspaceEnvironment(workspaceId, "error", message);
        addToast(`Workspace environment failed: ${message}`);
      });

    return () => {
      // Don't mutate status here — the previous "set to idle on
      // cleanup" behaviour combined with the gate's old loose check
      // to permanently lock the UI when the second-invocation
      // closure swallowed its own resolution. The `Complete` event
      // (Rust-side Drop) is the recovery mechanism; nothing here
      // needs to force an interim state.
      cancelled = true;
    };
  }, [
    selectedWorkspaceId,
    selectedWorkspaceRemoteConnectionId,
    setWorkspaceEnvironment,
    addToast,
  ]);
}
