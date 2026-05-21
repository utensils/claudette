import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, GitBranch, MinusCircle, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/useAppStore";
import {
  cancelWorkspacesBulk,
  computeReclaimableBytesForWorkspaces,
  computeStorageStats,
  deleteWorkspacesBulk,
  type BulkCleanupProgress,
} from "../../services/tauri";
import { RepoIcon } from "../shared/RepoIcon";
import { formatBytes } from "../../utils/formatBytes";
import type { Repository, Workspace } from "../../types";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./BulkCleanupArchivedModal.module.css";
import {
  AGE_FILTERS,
  type AgeBucket,
  type AgeFilter,
  ageBucket,
  filterByAge,
  groupByRepository,
  parseCreatedAt,
} from "./BulkCleanupArchivedModal.helpers";

/** Per-row terminal state populated from `bulk-cleanup-progress` events
 *  during a run. Rows that haven't been processed yet are absent from
 *  the map — the row UI treats absence as "pending" (spinner). */
type RowProgressStatus = "deleted" | "failed" | "cancelled";

interface RowProgress {
  status: RowProgressStatus;
  error?: string;
}

/** Run lifecycle. Drives which controls render (Cancel vs Cancelling…
 *  vs Confirm). `requestId` is the UUID the modal generated when it
 *  invoked `deleteWorkspacesBulk` — kept in state so the Cancel button
 *  can target the right run and the event listener can filter events. */
type RunState =
  | { kind: "idle" }
  | { kind: "running"; requestId: string; cancelling: boolean };

export function BulkCleanupArchivedModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  // `repoId` is one of:
  //   - a string  → single-repo mode (the per-repo Clean up… button).
  //   - `null`    → cleanup-all mode (Storage section header button).
  //   - missing / wrong type → close immediately. A future deep-link
  //     opening the modal without `repoId` set is still legal as
  //     long as the caller sets it to `null` explicitly.
  const repoId = (() => {
    if (modalData.repoId === null) return null;
    if (typeof modalData.repoId === "string" && modalData.repoId.length > 0) {
      return modalData.repoId;
    }
    return undefined;
  })();
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (repoId === undefined) closeModal();
  }, [repoId, closeModal]);

  const ageBucketLabel = (bucket: AgeBucket | null): string => {
    if (!bucket) return "";
    switch (bucket.kind) {
      case "today":
        return t("bulk_cleanup_age_today");
      case "days":
        return t("bulk_cleanup_age_days", { count: bucket.count });
      case "months":
        return t("bulk_cleanup_age_months", { count: bucket.count });
      case "years":
        return t("bulk_cleanup_age_years", { count: bucket.count });
    }
  };

  // Local repos only — bulk delete dispatches to the local Tauri
  // command, which can't reach workspaces owned by a paired remote
  // connection. Cleanup-all flattens across every local repo.
  const localRepoIds = useMemo(
    () =>
      new Set(
        repositories.filter((r) => !r.remote_connection_id).map((r) => r.id),
      ),
    [repositories],
  );

  const archived = useMemo<Workspace[]>(
    () =>
      workspaces
        .filter((w) => {
          if (w.status !== "Archived") return false;
          if (w.remote_connection_id) return false;
          if (!localRepoIds.has(w.repository_id)) return false;
          if (repoId !== null && w.repository_id !== repoId) return false;
          return true;
        })
        .sort((a, b) => {
          const av = parseCreatedAt(a.created_at) ?? Number.NEGATIVE_INFINITY;
          const bv = parseCreatedAt(b.created_at) ?? Number.NEGATIVE_INFINITY;
          return bv - av;
        }),
    [workspaces, repoId, localRepoIds],
  );

  const [ageFilter, setAgeFilter] = useState<AgeFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  // Live per-row status during a run, keyed by workspace_id. Cleared
  // when a fresh run starts; preserved between Cancel and the toast so
  // the user sees the final counts before the modal closes.
  const [progress, setProgress] = useState<Map<string, RowProgress>>(
    new Map(),
  );
  // Snapshot of ids dispatched at the start of the current run. Used
  // as the source of truth for the live list — `archived` may shrink
  // mid-run as the Deleted hook evicts rows from the Zustand store,
  // and we want the list to keep rendering every row through to its
  // terminal status.
  const [runIds, setRunIds] = useState<string[]>([]);

  // workspace_id → on-disk worktree size in bytes. Populated by a single
  // `compute_storage_stats` call when the modal mounts so the user can
  // see what each archived workspace will free up before confirming
  // cleanup. `null` while the scan is in flight; missing keys after the
  // scan mean the worktree dir doesn't exist on disk (still safe to
  // delete the DB row — the size column just renders a dash).
  const [sizeById, setSizeById] = useState<Map<string, number> | null>(null);
  // Set of workspace ids the *backend* currently sees as Archived (from
  // the same `compute_storage_stats` scan). Used to suppress rows whose
  // optimistic store update hasn't been committed to the DB yet — see
  // `useWorkspaceLifecycle.archive`, which flips the store entry to
  // Archived *before* awaiting the backend call. Without this guard a
  // user who archives N workspaces and immediately opens the cleanup
  // modal sees the row, clicks Delete, and gets N copies of
  // "workspace no longer archived" because the DB rows are still
  // `active`. `null` while the scan runs; we fall back to trusting the
  // store on scan failure (matches pre-fix behavior).
  const [backendArchivedIds, setBackendArchivedIds] = useState<Set<
    string
  > | null>(null);
  // Set-aware reclaimable-bytes total for the current selection. The
  // per-row `sizeById` figure is each workspace's *sole-owned* bytes,
  // which is the honest single-delete number but undercounts when two
  // selected workspaces share a dedup blob (each row excludes the
  // shared blob, so naïvely summing them excludes it twice even though
  // deleting both actually reclaims one copy). This state holds the
  // backend's set-based reclaim figure for the current selection so
  // the headline "N · X MB" total stays accurate under dedup.
  //
  // `null` means "no backend value yet" — the display falls back to
  // the client-side sole-owned sum (always a lower bound on the truth)
  // until the call resolves or fails.
  const [setReclaimableBytes, setSetReclaimableBytes] = useState<
    number | null
  >(null);
  // Re-scan whenever the set of archived ids in the store changes —
  // catches the moment an in-flight archive resolves and the
  // `useWorkspaceLifecycle.archive` optimistic update is confirmed by
  // the backend. Keyed on a stable join string so an unrelated row
  // edit (status_line, agent_status) doesn't refire the scan. Inlined
  // into the effect (rather than extracted to a `useCallback`) so the
  // per-invocation `cancelled` flag and the cleanup closure share one
  // scope — `useCallback` returning a cleanup is non-idiomatic React.
  const archivedIdJoin = useMemo(
    () =>
      workspaces
        .filter((w) => w.status === "Archived" && !w.remote_connection_id)
        .map((w) => w.id)
        .sort()
        .join(","),
    [workspaces],
  );
  useEffect(() => {
    let cancelled = false;
    computeStorageStats()
      .then((stats) => {
        if (cancelled) return;
        const nextSize = new Map<string, number>();
        const nextArchived = new Set<string>();
        for (const r of stats) {
          for (const w of r.workspaces) {
            if (w.size_bytes != null) nextSize.set(w.id, w.size_bytes);
            if (w.status === "Archived") nextArchived.add(w.id);
          }
        }
        setSizeById(nextSize);
        setBackendArchivedIds(nextArchived);
      })
      .catch(() => {
        if (cancelled) return;
        // Treat a failed scan as "no info available" — render dashes
        // in the size column and trust the store snapshot rather than
        // blocking cleanup entirely.
        setSizeById(new Map());
        setBackendArchivedIds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [archivedIdJoin]);

  const nowSecs = useMemo(() => Math.floor(Date.now() / 1000), []);

  const eligible = useMemo<Workspace[]>(
    () => filterByAge(archived, ageFilter, nowSecs),
    [archived, ageFilter, nowSecs],
  );

  // Rows the store says are Archived but the DB scan does NOT see as
  // Archived (e.g. archive call is still in flight after an optimistic
  // `useWorkspaceLifecycle.archive` update). Surfaced as a disabled
  // "archiving…" badge so the user understands why those rows aren't
  // selectable yet, instead of seeing an opaque "workspace no longer
  // archived" error after clicking Delete.
  const pendingArchiveIds = useMemo(() => {
    if (backendArchivedIds === null) return new Set<string>();
    const out = new Set<string>();
    for (const w of archived) {
      if (!backendArchivedIds.has(w.id)) out.add(w.id);
    }
    return out;
  }, [archived, backendArchivedIds]);

  // Eligible IDs exclude pending-archive rows so neither "Select all"
  // nor a stale `selected` set ever sends an in-flight workspace to the
  // backend — that's the path that produced the "workspace no longer
  // archived" failures on first click.
  const eligibleIds = useMemo(
    () =>
      new Set(
        eligible.filter((w) => !pendingArchiveIds.has(w.id)).map((w) => w.id),
      ),
    [eligible, pendingArchiveIds],
  );

  const effectiveSelection = useMemo(() => {
    const out = new Set<string>();
    for (const id of selected) {
      if (eligibleIds.has(id)) out.add(id);
    }
    return out;
  }, [selected, eligibleIds]);

  const allEligibleSelected =
    eligible.length > 0 && effectiveSelection.size === eligible.length;

  // Refresh the backend-computed set-reclaim figure whenever the user
  // changes the selection. The join key keeps the dependency stable so
  // a Set instance swap with the same contents doesn't refire — only
  // actual selection changes do. `cancelled` guards against the user
  // toggling rapidly: if a newer call has started, drop the stale
  // result instead of clobbering the current one.
  const selectionJoin = useMemo(
    () => [...effectiveSelection].sort().join(","),
    [effectiveSelection],
  );
  useEffect(() => {
    if (effectiveSelection.size === 0) {
      setSetReclaimableBytes(0);
      return;
    }
    let cancelled = false;
    computeReclaimableBytesForWorkspaces([...effectiveSelection])
      .then((n) => {
        if (!cancelled) setSetReclaimableBytes(n);
      })
      .catch(() => {
        // Backend failure → drop back to the client-side sum
        // (rendered when this state is null in the counter below).
        if (!cancelled) setSetReclaimableBytes(null);
      });
    return () => {
      cancelled = true;
    };
    // selectionJoin captures the selection set's identity; the Set
    // itself is recreated on every render so listing it directly
    // would refire every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionJoin]);

  // Workspaces rendered during a run come from `runIds` (the dispatched
  // snapshot) — we look up each id in `workspaces` to get the row data.
  // If the Zustand store has already evicted it (Deleted hook fired
  // before this render), we synthesize a minimal record from the
  // progress event's `name` payload so the row still renders with a
  // visible label and its final status icon.
  const runRows = useMemo<Workspace[]>(() => {
    if (runIds.length === 0) return [];
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    return runIds.map((id) => {
      const live = byId.get(id);
      if (live) return live;
      // Synthesized fallback for evicted rows. `name` is left empty
      // so the row renderer's `ws.name || runNamesRef.current.get(ws.id)
      // || ws.id` chain falls through to the dispatch-time snapshot
      // (or the event payload), giving the user a real workspace
      // name instead of a UUID-looking id.
      return {
        id,
        repository_id: "",
        name: "",
        branch_name: "",
        worktree_path: null,
        status: "Archived",
        agent_status: "Stopped",
        status_line: "",
        created_at: "",
        sort_order: 0,
        remote_connection_id: null,
      } satisfies Workspace;
    });
  }, [runIds, workspaces]);

  // Name snapshot captured at run start so evicted rows can still show
  // their original workspace name in the live list. Keyed by
  // workspace_id; survives until the next run begins.
  const runNamesRef = useRef<Map<string, string>>(new Map());

  // workspace_id → repository_id snapshot at dispatch time. Used in
  // run mode to reconstruct grouping even after Zustand evictions
  // null out `row.repository_id` on the synthesized placeholder.
  const runIdToRepoIdRef = useRef<Map<string, string>>(new Map());

  // Tracks whether the modal is still mounted. Prevents the
  // dispatched `handleDelete` promise from calling `closeModal()`
  // (a global store action that dismisses *whatever* modal is open)
  // after the user has closed this modal and opened a different one.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Active request id for the in-flight run. The progress listener
  // reads this ref to filter events instead of subscribing per-run,
  // which avoids three lifecycle hazards from the prior per-run
  // effect design: a listen()-race where fast events emit before
  // the subscribe resolves; an unsubscribe/resubscribe gap when the
  // user clicks Cancel and flips `runState.cancelling`; and an
  // `unlisten` leak when the effect cleans up before the async
  // listen() resolves.
  const currentRequestIdRef = useRef<string | null>(null);

  const clearStaleFailures = () => {
    setFailures((prev) => (prev.size === 0 ? prev : new Map()));
  };

  const handleAgeFilterChange = (next: AgeFilter) => {
    if (runState.kind === "running") return;
    setAgeFilter(next);
    clearStaleFailures();
  };

  const toggleRow = (id: string) => {
    if (runState.kind === "running") return;
    clearStaleFailures();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (runState.kind === "running") return;
    clearStaleFailures();
    if (allEligibleSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligible.map((w) => w.id)));
    }
  };

  // Install the progress listener once at mount, filter inside the
  // handler via `currentRequestIdRef`. Replaces the prior per-run
  // effect that had three race / leak hazards (see ref comment).
  // The listener is unregistered when the modal unmounts.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    (async () => {
      try {
        const fn = await listen<BulkCleanupProgress>(
          "bulk-cleanup-progress",
          (event) => {
            const payload = event.payload;
            if (payload.requestId !== currentRequestIdRef.current) return;
            setProgress((prev) => {
              const next = new Map(prev);
              next.set(payload.workspaceId, {
                status: payload.status,
                error: payload.error,
              });
              return next;
            });
            if (payload.name) {
              runNamesRef.current.set(payload.workspaceId, payload.name);
            }
          },
        );
        if (cancelled) {
          // The effect cleaned up before listen() resolved (modal
          // unmounted very fast). Immediately invoke the returned
          // unlisten so we don't leave a stale handler registered for
          // the lifetime of the webview.
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        // No event bridge → the live list won't update incrementally,
        // but the final result still resolves. The modal still works,
        // just without the per-row animation.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleDelete = async () => {
    const ids = [...effectiveSelection];
    if (ids.length === 0) return;

    // Snapshot names + repo ids before dispatch so the live list
    // keeps labels and grouping even after the `Deleted` hook
    // evicts rows from the Zustand store.
    runNamesRef.current = new Map(
      eligible
        .filter((w) => effectiveSelection.has(w.id))
        .map((w) => [w.id, w.name]),
    );
    runIdToRepoIdRef.current = new Map(
      ids.map((id) => [
        id,
        workspaces.find((w) => w.id === id)?.repository_id ?? "",
      ]),
    );

    const requestId = crypto.randomUUID();
    // Set the ref BEFORE invoking the backend so the at-mount
    // listener filters in any events that fire before React commits
    // the `setRunState` below — the DB pass can complete a few
    // rows in single-digit milliseconds.
    currentRequestIdRef.current = requestId;
    setRunIds(ids);
    setProgress(new Map());
    setFailures(new Map());
    setRunState({ kind: "running", requestId, cancelling: false });

    try {
      const result = await deleteWorkspacesBulk(ids, requestId);
      for (const id of result.deleted) {
        removeWorkspace(id);
      }
      const succeeded = result.deleted.length;
      const failed = result.failed.length;
      const skipped = result.cancelled.length;

      if (failed === 0 && skipped === 0) {
        addToast(
          t(
            succeeded === 1
              ? "bulk_cleanup_success_singular"
              : "bulk_cleanup_success_plural",
            { count: succeeded },
          ),
        );
        // Background-completion guard: if the modal was closed (or
        // replaced) while the run was in flight, `closeModal()` would
        // dismiss whatever modal is now open. Only close when we're
        // still mounted.
        if (mountedRef.current) closeModal();
        return;
      }

      if (failed === 0 && skipped > 0) {
        // Pure cancel — the user got out cleanly, nothing failed.
        addToast(
          t("bulk_cleanup_cancelled_toast", {
            succeeded,
            cancelled: skipped,
          }),
        );
        if (mountedRef.current) closeModal();
        return;
      }

      // Partial failure (with or without cancellations). When the
      // user also cancelled, surface the skipped count too — they
      // need to know some rows were intentionally left untouched
      // and require a re-run, separate from the failures.
      const failureMap = new Map<string, string>();
      for (const f of result.failed) failureMap.set(f.id, f.error);
      setFailures(failureMap);
      setSelected(new Set(result.failed.map((f) => f.id)));
      addToast(
        skipped > 0
          ? t("bulk_cleanup_partial_with_cancelled", {
              succeeded,
              failed,
              cancelled: skipped,
            })
          : t("bulk_cleanup_partial", { succeeded, failed }),
      );
    } catch (e) {
      addToast(
        t("bulk_cleanup_failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      currentRequestIdRef.current = null;
      // Clear `runIds` so `renderingRun` (keyed on `runIds.length`,
      // not `progress.size`) flips back to false. We intentionally
      // leave `progress` populated for the partial-failure path so
      // failed rows can keep their per-row error string visible in
      // idle mode — the renderer reads `failures.get(id)` first and
      // falls back to `progress.get(id)?.error` if absent.
      setRunState({ kind: "idle" });
      setRunIds([]);
    }
  };

  const handleCancel = useCallback(() => {
    if (runState.kind !== "running") return;
    setRunState({
      kind: "running",
      requestId: runState.requestId,
      cancelling: true,
    });
    // Fire-and-forget; cooperative cancel only signals, the in-flight
    // `deleteWorkspacesBulk` promise will resolve with the partial
    // result and the finally{} above will reset state.
    void cancelWorkspacesBulk(runState.requestId).catch(() => {
      // The backend may have already finished and unregistered the
      // flag — `false` return is fine, the promise rejecting is
      // unexpected but not actionable here.
    });
  }, [runState]);

  // Close-while-running implies cancel. Cancel doesn't immediately
  // close the modal (so the user sees the run finalize), but if they
  // click X / Escape / backdrop, we cancel AND close. The dispatched
  // promise still resolves in the background; its toast still fires
  // via the global `addToast` even after the modal unmounts.
  const handleClose = useCallback(() => {
    if (runState.kind === "running") {
      void cancelWorkspacesBulk(runState.requestId).catch(() => {});
    }
    closeModal();
  }, [runState, closeModal]);

  const isRunning = runState.kind === "running";
  const cancelling = isRunning && runState.cancelling;

  // Live counters from the progress map. During a run these replace
  // the static "selected" counter; after a run they're zero again.
  const counts = useMemo(() => {
    let deleted = 0;
    let failed = 0;
    let cancelled = 0;
    for (const entry of progress.values()) {
      if (entry.status === "deleted") deleted += 1;
      else if (entry.status === "failed") failed += 1;
      else if (entry.status === "cancelled") cancelled += 1;
    }
    return { deleted, failed, cancelled };
  }, [progress]);

  const repo =
    repoId && typeof repoId === "string"
      ? repositories.find((r) => r.id === repoId) ?? null
      : null;

  const title =
    repoId && typeof repoId === "string"
      ? t("bulk_cleanup_title", {
          repo: repo?.name ?? t("bulk_cleanup_title_fallback_repo"),
        })
      : t("bulk_cleanup_title_all");

  // What we render in the list depends on whether a run is in flight.
  // - Idle / no run: render `eligible`, optionally grouped by repo in
  //   cleanup-all mode.
  // - Running: render `runRows` (the dispatched snapshot), still
  //   grouped by repo in cleanup-all mode. Selection checkboxes are
  //   replaced with status icons.
  //
  // Keyed on `runIds.length`, not `progress.size`. The partial-failure
  // path clears `runIds` (so the modal flips back to idle and the
  // failed rows render in the eligible list with their per-row error)
  // but intentionally leaves `progress` populated so a fast Cancel→
  // retry round-trip doesn't lose context. Using `progress.size`
  // would trap the modal in run-mode with an empty `runRows` list.
  const renderingRun = isRunning || runIds.length > 0;
  const rowsForRender = renderingRun ? runRows : eligible;
  const groupedForRender = useMemo(() => {
    if (repoId !== null) {
      return [{ repo: null as Repository | null, workspaces: rowsForRender }];
    }
    // Cleanup-all mode: group by repo. During a run, fall back to the
    // snapshotted repo map for any row whose store entry has been
    // evicted (so the header doesn't disappear before the last row of
    // a fully-deleted repo lands).
    const sourceRepos: Repository[] = repositories.filter((r) =>
      localRepoIds.has(r.id),
    );
    if (!renderingRun) {
      return groupByRepository(rowsForRender, sourceRepos).map(
        ({ repo: r, workspaces: ws }) => ({
          repo: r as Repository | null,
          workspaces: ws,
        }),
      );
    }
    // Run mode: rows are runRows in dispatch order; their live
    // `repository_id` may be empty for evicted placeholders. The
    // dispatch-time snapshot map is the source of truth.
    const byRepoId = new Map<string, Workspace[]>();
    for (const row of rowsForRender) {
      const repoIdForRow =
        row.repository_id || runIdToRepoIdRef.current.get(row.id) || "";
      const bucket = byRepoId.get(repoIdForRow);
      if (bucket) bucket.push(row);
      else byRepoId.set(repoIdForRow, [row]);
    }
    // Order groups by `sourceRepos` so the visual order stays stable
    // even as rows arrive in dispatch order (which may interleave
    // across repos).
    const out: { repo: Repository | null; workspaces: Workspace[] }[] = [];
    for (const r of sourceRepos) {
      const ws = byRepoId.get(r.id);
      if (ws && ws.length > 0) out.push({ repo: r, workspaces: ws });
    }
    return out;
  }, [rowsForRender, repoId, repositories, renderingRun, localRepoIds]);

  const totalForCounter = renderingRun ? runIds.length : eligible.length;

  // All hooks above run unconditionally; the render-time bail comes
  // here. The effect at the top has already scheduled `closeModal()`
  // for the next tick — this short-circuit just suppresses the
  // otherwise-visible flash of an empty modal on the way out.
  if (repoId === undefined) return null;

  return (
    <Modal title={title} onClose={handleClose} wide bodyScroll>
      <div className={shared.warning}>{t("bulk_cleanup_warning")}</div>

      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>
          {t("bulk_cleanup_older_than")}
        </span>
        <div className={styles.filterChoices} role="radiogroup">
          {AGE_FILTERS.map((f) => (
            <label
              key={f.key}
              className={
                ageFilter === f.key
                  ? styles.filterChipActive
                  : styles.filterChip
              }
            >
              <input
                type="radio"
                name="bulk-cleanup-age"
                value={f.key}
                checked={ageFilter === f.key}
                disabled={isRunning}
                onChange={() => handleAgeFilterChange(f.key)}
                className={styles.filterRadio}
              />
              {t(`bulk_cleanup_filter_${f.key}`)}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.headerRow}>
        {renderingRun ? (
          // During a run, the select-all checkbox is meaningless — the
          // selection is locked. Show the live progress counter
          // instead so the user can read forward motion at a glance.
          // `role=status` + `aria-live=polite` mirrors the convention
          // used in ChatPanel and SettingsPage so screen readers
          // announce each per-row completion.
          <span
            className={styles.progressCounter}
            role="status"
            aria-live="polite"
          >
            {t("bulk_cleanup_live_counter", {
              deleted: counts.deleted,
              total: totalForCounter,
              failed: counts.failed,
            })}
          </span>
        ) : (
          <label className={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={allEligibleSelected}
              disabled={eligible.length === 0}
              onChange={toggleSelectAll}
            />
            <span>{t("bulk_cleanup_select_all")}</span>
          </label>
        )}
        {!renderingRun && (
          <span className={styles.counter}>
            {t("bulk_cleanup_counter", {
              selected: effectiveSelection.size,
              total: eligible.length,
            })}
            {sizeById !== null && effectiveSelection.size > 0 && (
              <>
                {" · "}
                {t("bulk_cleanup_selected_size", {
                  // Prefer the backend's set-aware figure when it has
                  // resolved; otherwise the client-side sole-owned sum
                  // is shown as a graceful loading / fallback value.
                  // The client sum is a lower bound on the truth (it
                  // double-excludes blobs shared within the selection),
                  // so flashing it briefly is safe — the number can
                  // only tick up when the backend value arrives.
                  size: formatBytes(
                    setReclaimableBytes ??
                      [...effectiveSelection].reduce(
                        (sum, id) => sum + (sizeById.get(id) ?? 0),
                        0,
                      ),
                  ),
                })}
              </>
            )}
          </span>
        )}
      </div>

      {rowsForRender.length === 0 ? (
        <div className={styles.empty}>{t("bulk_cleanup_no_eligible")}</div>
      ) : (
        groupedForRender.map((group, gi) => (
          <div key={group.repo?.id ?? `group-${gi}`}>
            {repoId === null && group.repo && (
              <div className={styles.repoHeader}>
                {group.repo.icon && (
                  <RepoIcon icon={group.repo.icon} size={11} />
                )}
                {group.repo.name}
              </div>
            )}
            <ul className={styles.repoSection}>
              {group.workspaces.map((ws) => {
                const rowProgress = progress.get(ws.id);
                const isSelected = effectiveSelection.has(ws.id);
                const isPending = pendingArchiveIds.has(ws.id);
                const err = failures.get(ws.id) ?? rowProgress?.error;
                const displayName =
                  ws.name || runNamesRef.current.get(ws.id) || ws.id;
                // Idle rows wrap in a <label> so clicking the workspace
                // name / branch / age toggles the checkbox (matches the
                // pre-multirepo UX). Running rows can't be toggled, and
                // the status icon takes the click target slot — render
                // a non-label <div> in that case so the spinner /
                // check / X / dash isn't bound to a no-op input.
                const rowInner = (
                  <>
                    {renderingRun ? (
                      <span className={styles.rowStatus}>
                        {rowProgress?.status === "deleted" ? (
                          <Check
                            size={12}
                            className={styles.rowStatusDeleted}
                            aria-label={t("bulk_cleanup_row_deleted")}
                          />
                        ) : rowProgress?.status === "failed" ? (
                          <X
                            size={12}
                            className={styles.rowStatusFailed}
                            aria-label={t("bulk_cleanup_row_failed")}
                          />
                        ) : rowProgress?.status === "cancelled" ? (
                          <MinusCircle
                            size={12}
                            className={styles.rowStatusCancelled}
                            aria-label={t("bulk_cleanup_row_cancelled")}
                          />
                        ) : (
                          <span
                            className={styles.spinner}
                            aria-label={t("bulk_cleanup_row_pending")}
                          />
                        )}
                      </span>
                    ) : null}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={renderingRun || isPending}
                      onChange={() => toggleRow(ws.id)}
                      aria-label={displayName}
                      title={
                        isPending ? t("bulk_cleanup_pending_archive") : undefined
                      }
                    />
                    <span className={styles.rowName}>{displayName}</span>
                    <span className={styles.rowBranch}>
                      {ws.branch_name && (
                        <>
                          <GitBranch size={11} aria-hidden="true" />
                          {ws.branch_name}
                        </>
                      )}
                    </span>
                    <span className={styles.rowSize}>
                      {sizeById === null
                        ? "…"
                        : sizeById.has(ws.id)
                          ? formatBytes(sizeById.get(ws.id)!)
                          : "—"}
                    </span>
                    <span className={styles.rowAge}>
                      {ws.created_at &&
                        ageBucketLabel(ageBucket(ws.created_at, nowSecs))}
                    </span>
                  </>
                );
                return (
                  <li key={ws.id} className={styles.row}>
                    {renderingRun ? (
                      <div className={styles.rowLabelRunning}>{rowInner}</div>
                    ) : (
                      <label className={styles.rowLabel}>{rowInner}</label>
                    )}
                    {err && <div className={styles.rowError}>{err}</div>}
                    {!err && isPending && (
                      <div className={styles.rowPending}>
                        {t("bulk_cleanup_pending_archive")}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      <div className={shared.actions}>
        <button
          className={shared.btn}
          onClick={isRunning ? handleCancel : handleClose}
          disabled={cancelling}
        >
          {cancelling ? t("bulk_cleanup_cancelling") : tCommon("cancel")}
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleDelete}
          disabled={isRunning || effectiveSelection.size === 0}
        >
          {isRunning
            ? t("bulk_cleanup_deleting")
            : t("bulk_cleanup_confirm", { count: effectiveSelection.size })}
        </button>
      </div>
    </Modal>
  );
}
