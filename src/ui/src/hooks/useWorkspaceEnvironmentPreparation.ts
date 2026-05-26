import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { prepareWorkspaceEnvironment } from "../services/tauri";
import { envTargetFromWorkspace, reloadEnv } from "../services/env";
import { useAppStore } from "../stores/useAppStore";
import type { WorkspaceEnvTrustNeededPayload } from "../types/env";

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
  resolve_id?: string;
  plugin: string;
  phase: EnvProgressPhase;
  elapsed_ms: number;
  ok?: boolean;
}

/**
 * Payload shape for the `workspace_env_trust_needed` Tauri event,
 * mirroring `WorkspaceEnvTrustNeededPayload` + `TrustNeededEntry` in
 * src-tauri/src/commands/env.rs. Emitted whenever
 * `prepare_workspace_environment` detects an untrusted mise / direnv
 * config on the worktree; we route it into the `envTrust` modal so
 * the user gets a one-time per-project prompt instead of an opaque
 * toast.
 *
 * `message` is the human-readable one-liner the backend produces from
 * the raw stderr (`clean_trust_error_excerpt` chain). `config_path`
 * is the absolute file path the cleaner extracted — both can be
 * null/missing on the wire from an older backend build, so the
 * modal's `isEnvTrustModalData` validator and JSX render guards both
 * tolerate absence.
 */
/**
 * Heuristic match on the error string returned by
 * `prepare_workspace_environment` to suppress the legacy toast for the
 * trust-error case. The string itself is built in
 * `prepare_workspace_error` in env.rs; the backend now filters trust
 * errors out of that summary, so this guard is belt-and-suspenders for
 * older builds whose IPC response is still in flight when the new
 * frontend mounts.
 */
function looksLikeTrustError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("environment setup needed") ||
    lower.includes("not trusted") ||
    lower.includes("is blocked") ||
    lower.includes("is not allowed")
  );
}

function trustPayloadSignature(payload: WorkspaceEnvTrustNeededPayload): string {
  return JSON.stringify({
    workspace_id: payload.workspace_id,
    repo_id: payload.repo_id,
    plugins: payload.plugins.map((plugin) => ({
      plugin_name: plugin.plugin_name,
      config_path: plugin.config_path ?? null,
      error_excerpt: plugin.error_excerpt,
    })),
  });
}

/**
 * Match the error `prepare_workspace_environment` returns when the
 * workspace id no longer resolves to a DB row — `"Workspace not found"`,
 * raised by `resolve_target_from_db` in `src-tauri/src/commands/env.rs`.
 *
 * A workspace in this state is a ghost: the worktree + DB row were torn
 * down (a delete whose `workspaces-changed` event we missed, a worktree
 * pruned out from under us, a desync after a crash) but the sidebar row
 * lingers. The toast for this case is a dead end — there's no recovery
 * action — so the right move is to drop the row instead of stranding an
 * unactionable error next to it. See the `.catch` in the per-selection
 * effect below.
 */
function looksLikeMissingWorkspace(message: string): boolean {
  return message.toLowerCase().includes("workspace not found");
}

/**
 * How long a workspace-selection env resolve may run before the UI is
 * flipped to a "Preparing …" spinner. A cached resolve returns within
 * one IPC round-trip — far under this threshold — so the common
 * hot-cache path never renders the spinner at all (issue #888). Only a
 * genuine cold export crosses it.
 */
const PREPARING_SPINNER_DELAY_MS = 150;
export const ENV_PREPARATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CLOSED_RESOLVE_IDS_PER_WORKSPACE = 32;

export function envPreparationTimeoutMessage(): string {
  return "Workspace environment preparation timed out. You can retry environment setup from the chat banner.";
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
  // True when the currently-selected workspace is an optimistic
  // placeholder (fork OR create) — there's no backing DB row yet, so
  // the backend's `prepare_workspace_environment` would return
  // "Workspace not found" and the catch below would helpfully
  // `removeWorkspace()` the placeholder out of the sidebar mid-flight.
  // Skip env prep entirely for placeholders; the real env prep fires
  // off the swapped-in workspace id once `commitPendingFork` /
  // `commitPendingCreate` completes.
  const selectedWorkspaceIsPendingFork = useAppStore((s) =>
    s.selectedWorkspaceId
      ? !!s.pendingForks[s.selectedWorkspaceId] ||
        !!s.pendingCreates[s.selectedWorkspaceId]
      : false,
  );
  const selectedWorkspaceEnvironmentRetryNonce = useAppStore((s) =>
    s.selectedWorkspaceId
      ? (s.workspaceEnvironmentRetryNonce[s.selectedWorkspaceId] ?? 0)
      : 0,
  );
  const setWorkspaceEnvironment = useAppStore((s) => s.setWorkspaceEnvironment);
  const setWorkspaceEnvironmentProgress = useAppStore(
    (s) => s.setWorkspaceEnvironmentProgress,
  );
  const addToast = useAppStore((s) => s.addToast);
  const openModal = useAppStore((s) => s.openModal);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const promptedTrustSignaturesRef = useRef<Map<string, string>>(new Map());

  const openTrustModalOnce = useCallback((payload: WorkspaceEnvTrustNeededPayload) => {
    if (!payload.plugins?.length) return;
    const signature = trustPayloadSignature(payload);
    if (promptedTrustSignaturesRef.current.get(payload.workspace_id) === signature) {
      return;
    }
    promptedTrustSignaturesRef.current.set(payload.workspace_id, signature);
    openModal("envTrust", payload);
  }, [openModal]);

  // Per-workspace flag: did any plugin emit `finished { ok: false }`
  // during the current resolve? Used by the Complete handler to
  // decide between transitioning to "ready" (clean resolve) vs
  // "error" (something failed). Without this, a backend prep that
  // returned Err whose Tauri response was dropped by the WebView2
  // IPC bridge would still get silently marked "ready" — hiding
  // trust errors and provider failures from the user. Cleared on
  // each Complete so a subsequent resolve starts fresh.
  const failedDuringResolveRef = useRef<Map<string, boolean>>(new Map());
  const activeResolveIdRef = useRef<Map<string, string>>(new Map());
  const closedResolveIdsRef = useRef<Set<string>>(new Set());
  const closedResolveOrderRef = useRef<Map<string, string[]>>(new Map());

  // Per-workspace cancel functions for the pending spinner-delay
  // timers armed by the per-selection effect below. The `complete`
  // progress handler reaches in here to cancel a workspace's timer
  // once its resolve is done — critical for the dropped-Tauri-
  // response case, where the prep promise never settles so
  // `.then`/`.catch` never run to clear the timer themselves. Without
  // this a late timer fires after `complete` already finalized the
  // workspace and re-flips it to "preparing" — a stuck, blocked UI.
  const spinnerTimerClearsRef = useRef<Map<string, () => void>>(new Map());
  // Per-workspace hard timeout for selected-workspace preparation. Progress
  // `complete` usually clears the loading state, but if the IPC call stalls
  // before a sink is even constructed (for example behind a long SQLite lock)
  // no progress event can arrive. Keep the timeout outside effect cleanup so a
  // navigate-away/navigate-back cannot strand the row forever; a subsequent
  // prepare attempt clears the prior timer before arming its own.
  const preparationTimeoutClearsRef = useRef<Map<string, () => void>>(new Map());
  const handledRetryNonceRef = useRef<Map<string, number>>(new Map());

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
    const activeResolveIds = activeResolveIdRef.current;
    const closedResolveIds = closedResolveIdsRef.current;
    const closedResolveOrder = closedResolveOrderRef.current;
    const failureKey = (workspaceId: string, resolveId: string | undefined) =>
      `${workspaceId}\0${resolveId ?? "legacy"}`;
    const resolveKey = (workspaceId: string, resolveId: string) =>
      `${workspaceId}\0${resolveId}`;
    const rememberClosedResolve = (workspaceId: string, resolveId: string) => {
      const key = resolveKey(workspaceId, resolveId);
      if (closedResolveIds.has(key)) return;
      closedResolveIds.add(key);
      const order = closedResolveOrder.get(workspaceId) ?? [];
      order.push(key);
      while (order.length > MAX_CLOSED_RESOLVE_IDS_PER_WORKSPACE) {
        const evicted = order.shift();
        if (evicted) closedResolveIds.delete(evicted);
      }
      closedResolveOrder.set(workspaceId, order);
    };
    const isCurrentResolve = (
      workspaceId: string,
      resolveId: string | undefined,
    ) => {
      if (!resolveId) return true;
      if (closedResolveIds.has(resolveKey(workspaceId, resolveId))) {
        return false;
      }
      const active = activeResolveIds.get(workspaceId);
      return active === undefined || active === resolveId;
    };
    listen<WorkspaceEnvProgressPayload>("workspace_env_progress", (event) => {
      if (!mounted) return;
      const { workspace_id, resolve_id, plugin, phase, ok } = event.payload;
      if (phase === "started") {
        if (resolve_id && plugin !== "provisioning") {
          const previous = activeResolveIds.get(workspace_id);
          if (previous && previous !== resolve_id) {
            rememberClosedResolve(workspace_id, previous);
          }
          activeResolveIds.set(workspace_id, resolve_id);
        }
        setWorkspaceEnvironmentProgress(workspace_id, plugin);
      } else if (phase === "finished") {
        if (!isCurrentResolve(workspace_id, resolve_id)) return;
        setWorkspaceEnvironmentProgress(workspace_id, null);
        // Track per-plugin failures so the Complete handler below
        // can distinguish "all plugins succeeded — safe to mark
        // ready" from "something failed — mark error so a dropped
        // Tauri Err response doesn't silently paper over a trust
        // error or provider failure".
        if (ok === false) {
          failed.set(failureKey(workspace_id, resolve_id), true);
        }
      } else {
        if (!isCurrentResolve(workspace_id, resolve_id)) return;
        // phase === "complete" — fires once at end of every backend
        // resolve. Clear the active-plugin display and, critically,
        // transition any workspace stuck at "preparing" purely from
        // the progress-driven status bumps back to "ready" (or
        // "error" if any plugin reported failure). This recovers
        // the spawn_pty / agent-spawn paths where no dedicated
        // `.then` handler exists to finalize the status.
        setWorkspaceEnvironmentProgress(workspace_id, null);
        // The resolve is done — cancel any pending spinner-delay timer
        // for this workspace so it can't fire late and strand the
        // workspace back at "preparing". This is the recovery for a
        // dropped Tauri response, where the prep promise never settles
        // and `.then`/`.catch` never clear the timer themselves.
        spinnerTimerClearsRef.current.get(workspace_id)?.();
        preparationTimeoutClearsRef.current.get(workspace_id)?.();
        const key = failureKey(workspace_id, resolve_id);
        const anyFailed = failed.get(key) ?? false;
        failed.delete(key);
        if (resolve_id) {
          rememberClosedResolve(workspace_id, resolve_id);
          if (activeResolveIds.get(workspace_id) === resolve_id) {
            activeResolveIds.delete(workspace_id);
          }
        }
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

  // Listener for the trust-needed signal from the Rust side. The
  // backend emits this whenever env-provider resolve hits at least
  // one source whose stderr matches the trust-error heuristic. The
  // matching toast is suppressed below so the user sees only the
  // modal, not both.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    listen<WorkspaceEnvTrustNeededPayload>(
      "workspace_env_trust_needed",
      (event) => {
        if (!mounted) return;
        const { workspace_id, repo_id, plugins } = event.payload;
        if (!plugins || plugins.length === 0) return;
        openTrustModalOnce({
          workspace_id,
          repo_id,
          plugins,
        });
      },
    ).then((stop) => {
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
  }, [openTrustModalOnce]);

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
    // Optimistic-fork placeholder: leave the seeded `preparing` /
    // started_at entry alone (it drives the sidebar spinner) and
    // skip the IPC round trip.  The real prep fires once
    // `commitPendingFork` swaps the placeholder for the real
    // workspace id and the selection effect re-runs.
    if (selectedWorkspaceIsPendingFork) return;
    // If create_workspace / fork_workspace_at_checkpoint already
    // dispatched a resolve for this workspace (via its own warmup)
    // and we just swapped the placeholder out for the real id, the
    // sidebar's `workspaceEnvironment[realId]` is already "preparing"
    // with a `started_at` set by `setWorkspaceEnvironmentProgress`
    // — that's the warmup talking. Dispatching a second
    // `prepare_workspace_environment` here would race two concurrent
    // resolves on the env-provider mtime cache, and either sink's
    // `Complete` event could mark the workspace ready while the other
    // is still streaming. The warmup's own `Complete` will transition
    // us out of "preparing" either way, so just skip.
    //
    // Read directly from the store rather than via a selector — using
    // a selector here would re-run the effect when our own
    // `setWorkspaceEnvironment(_, "preparing")` below flips the flag
    // to `true`, cancelling the in-flight IPC mid-flight.
    const existingEnv =
      useAppStore.getState().workspaceEnvironment[selectedWorkspaceId];

    const workspaceId = selectedWorkspaceId;
    const retryNonce = selectedWorkspaceEnvironmentRetryNonce;
    const lastHandledRetryNonce =
      handledRetryNonceRef.current.get(workspaceId) ?? 0;
    const isRetry = retryNonce > lastHandledRetryNonce;
    if (isRetry) {
      handledRetryNonceRef.current.set(workspaceId, retryNonce);
    }
    let cancelled = false;
    let timedOut = false;

    const armPreparationTimeout = (delayMs: number) => {
      const preparationTimeouts = preparationTimeoutClearsRef.current;
      preparationTimeouts.get(workspaceId)?.();
      let preparationTimeout: ReturnType<typeof setTimeout> | undefined =
        setTimeout(() => {
          preparationTimeout = undefined;
          preparationTimeouts.delete(workspaceId);
          const cur = useAppStore.getState().workspaceEnvironment[workspaceId];
          if (cur?.status !== "preparing") return;
          timedOut = true;
          const message = envPreparationTimeoutMessage();
          useAppStore
            .getState()
            .setWorkspaceEnvironment(workspaceId, "error", message);
          const state = useAppStore.getState();
          if (state.selectedWorkspaceId === workspaceId) {
            state.addToast(message);
          }
        }, delayMs);
      const clearPreparationTimeout = () => {
        if (preparationTimeout !== undefined) {
          clearTimeout(preparationTimeout);
          preparationTimeout = undefined;
        }
        preparationTimeouts.delete(workspaceId);
      };
      preparationTimeouts.set(workspaceId, clearPreparationTimeout);
      return clearPreparationTimeout;
    };

    if (
      existingEnv?.status === "preparing" &&
      existingEnv.started_at !== undefined &&
      !isRetry
    ) {
      const elapsedMs = Math.max(0, Date.now() - existingEnv.started_at);
      armPreparationTimeout(
        Math.max(0, ENV_PREPARATION_TIMEOUT_MS - elapsedMs),
      );
      return;
    }

    const clearPreparationTimeout = armPreparationTimeout(
      ENV_PREPARATION_TIMEOUT_MS,
    );

    // Hot-cache path: don't flip the workspace to "preparing"
    // synchronously. A cached env resolve returns within one IPC
    // round-trip — the backend's work is sub-millisecond on a cache
    // hit — so eagerly rendering "Preparing direnv…" guarantees a
    // spinner flicker on every workspace switch even when nothing
    // reloaded. Instead, arm a short timer: if the resolve hasn't come
    // back by then it's a genuine cold export and the spinner is
    // warranted. A fast (cached) resolve clears the timer before it
    // fires, so the status goes straight to "ready" with no
    // intermediate "preparing" frame.
    //
    // Cache *misses* still surface a spinner without waiting on this
    // timer: the backend emits `workspace_env_progress {started}` for
    // every plugin it actually runs, and the listener above routes
    // that through `setWorkspaceEnvironmentProgress`, which forces the
    // status to "preparing" (with the richer per-plugin elapsed-time
    // fields the sidebar needs).
    const spinnerTimers = spinnerTimerClearsRef.current;
    let preparingTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        preparingTimer = undefined;
        spinnerTimers.delete(workspaceId);
        if (cancelled || timedOut) return;
        // Only promote a genuine pre-resolve state. A workspace the
        // resolve already finalized (`ready` / `error`) must never be
        // dragged back to "preparing" — and one a `started` progress
        // event already moved to "preparing" keeps its richer
        // `current_plugin` / `started_at` fields untouched. A slow
        // resolve still in flight sits at `undefined` / `"idle"`; for
        // that the spinner is warranted, and the eventual `complete`
        // event recovers it back to "ready".
        const cur =
          useAppStore.getState().workspaceEnvironment[workspaceId]?.status;
        if (cur === undefined || cur === "idle") {
          setWorkspaceEnvironment(workspaceId, "preparing");
        }
      },
      PREPARING_SPINNER_DELAY_MS,
    );
    const clearPreparingTimer = () => {
      if (preparingTimer !== undefined) {
        clearTimeout(preparingTimer);
        preparingTimer = undefined;
      }
      spinnerTimers.delete(workspaceId);
    };
    // Register so the `complete` progress handler can cancel this
    // timer even when the prep promise never settles (a dropped Tauri
    // response) and `.then` / `.catch` never run to clear it.
    spinnerTimers.set(workspaceId, clearPreparingTimer);

    // The recovery path for a dropped Tauri response on Windows
    // lives in the progress listener above: the `Complete` phase
    // (emitted by Drop on the Rust-side sink) transitions any
    // workspace stuck at "preparing" purely from progress events
    // back to "ready". So this `.then` is no longer load-bearing
    // for unlock — it's just the authoritative success update
    // when the IPC response does make it back. `.catch` still
    // respects `cancelled` so navigating away mid-flight doesn't
    // surface a stale toast for a workspace the user already left.
    const prepare = async () => {
      if (isRetry) {
        await reloadEnv(envTargetFromWorkspace(workspaceId));
      }
      if (cancelled || timedOut) return undefined;
      return prepareWorkspaceEnvironment(workspaceId);
    };

    prepare()
      .then((payload) => {
        clearPreparingTimer();
        clearPreparationTimeout();
        if (cancelled || timedOut) return;
        // The backend also emits `workspace_env_trust_needed`, but
        // Tauri listener registration is async. On a fast cached
        // resolve during app/workspace startup, the command can finish
        // before the event subscription is live. Returning the same
        // payload lets this selected-workspace prep path deterministically
        // show the modal; the event remains useful for watcher-driven
        // invalidations and other non-selected resolve sites.
        if (payload) openTrustModalOnce(payload);
        setWorkspaceEnvironment(workspaceId, "ready");
      })
      .catch((err) => {
        clearPreparingTimer();
        clearPreparationTimeout();
        if (cancelled || timedOut) return;
        const message = String(err);
        // The workspace row is gone from the DB but still showing in the
        // sidebar (a delete whose `workspaces-changed` event we missed, a
        // worktree pruned externally, a post-crash desync). Nothing the
        // user can do with a ghost row — drop it and deselect instead of
        // parking an unactionable "Workspace not found" error next to a
        // row that will only fail the same way on every interaction.
        if (looksLikeMissingWorkspace(message)) {
          removeWorkspace(workspaceId);
          addToast("Workspace no longer exists — removed from the sidebar.");
          return;
        }
        setWorkspaceEnvironment(workspaceId, "error", message);
        // Trust-class failures are routed through the
        // `workspace_env_trust_needed` event + EnvTrustModal — the
        // modal is the actionable surface, the toast was a dead end
        // before this feature landed. Skip the toast in that case so
        // the user isn't double-prompted.
        if (!looksLikeTrustError(message)) {
          addToast(`Workspace environment failed: ${message}`);
        }
      });

    return () => {
      // Don't mutate status here — the previous "set to idle on
      // cleanup" behaviour combined with the gate's old loose check
      // to permanently lock the UI when the second-invocation
      // closure swallowed its own resolution. The `Complete` event
      // (Rust-side Drop) is the recovery mechanism; nothing here
      // needs to force an interim state. We do cancel the pending
      // spinner timer so a workspace the user already left can't
      // flip to "preparing" after the fact.
      clearPreparingTimer();
      cancelled = true;
    };
  }, [
    selectedWorkspaceId,
    selectedWorkspaceRemoteConnectionId,
    selectedWorkspaceIsPendingFork,
    selectedWorkspaceEnvironmentRetryNonce,
    setWorkspaceEnvironment,
    addToast,
    openTrustModalOnce,
    removeWorkspace,
  ]);
}

// Internal: exposed for vitest. The hook is the only production
// consumer.
export const __TEST__ = {
  looksLikeTrustError,
  looksLikeMissingWorkspace,
  PREPARING_SPINNER_DELAY_MS,
  ENV_PREPARATION_TIMEOUT_MS,
  envPreparationTimeoutMessage,
};
