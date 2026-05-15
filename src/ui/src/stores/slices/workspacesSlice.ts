import type { StateCreator } from "zustand";
import { notifyWorkspaceSelected } from "../../services/tauri";
import type { Workspace } from "../../types";
import type { AppState } from "../useAppStore";

// Fire-and-forget wrapper around the typed service call. Errors are
// swallowed because selection is a pure UI action — a failed notification
// just means the backend keeps polling on its prior tier, which is fine.
/** True when `real` could be the post-allocator name for a workspace
 *  whose requested name was `placeholder`. The Rust allocator
 *  (`src/workspace_alloc.rs`) takes the requested name on the first
 *  attempt and appends `-2`, `-3`, … on collision until it finds a
 *  free slot. So either exact match, or `placeholder-N` where N is a
 *  positive integer. Used by the eager-swap fallback to associate an
 *  optimistic placeholder with the real workspace even when the
 *  allocator added a numeric suffix.
 *
 *  Deliberately strict: matching `<placeholder>-anything` (no digit
 *  guard) would let an unrelated workspace named e.g. `main-fork-bug`
 *  swap a `main-fork` placeholder out from under the user. */
function realNameMatchesAllocatorSuffix(
  placeholder: string,
  real: string,
): boolean {
  if (real === placeholder) return true;
  const prefix = `${placeholder}-`;
  if (!real.startsWith(prefix)) return false;
  const suffix = real.slice(prefix.length);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/** Match an incoming `workspaces-changed (created)` workspace against
 *  any pending optimistic-create / optimistic-fork placeholder in the
 *  store. Returns the placeholder id + the slice the match came from,
 *  or null if no swap is needed. Extracted so App.tsx's listener can
 *  call a pure function — keeps the matching heuristic testable
 *  without mounting React.
 *
 *  Matching is exact on `repository_id`, and on name the real workspace
 *  must either equal the placeholder name (the common case — create
 *  passes the slug verbatim) or look like an allocator-suffix variant
 *  (`<placeholder>-N`). The earlier "any single in-flight placeholder
 *  in this repo" fallback was too lax: a concurrent CLI / IPC create
 *  in the same repo would get cross-associated with the placeholder
 *  and steal the user's selection.
 */
export function findPendingPlaceholderForCreatedWorkspace(args: {
  workspaces: Workspace[];
  pendingCreates: Record<string, string>;
  pendingForks: Record<string, string>;
  real: Workspace;
}): { placeholderId: string; from: "create" | "fork" } | null {
  const matchingRepo = args.workspaces.filter(
    (w) =>
      (w.id in args.pendingCreates || w.id in args.pendingForks) &&
      w.repository_id === args.real.repository_id,
  );
  // Prefer exact match, then allocator-suffix match. Only consider the
  // suffix candidate when exactly one placeholder is in flight; with
  // multiple in-flight placeholders we can't safely guess which one
  // the suffix-bearing name resolves to, and the IPC return path will
  // commit the right one anyway.
  const exact = matchingRepo.find((w) => w.name === args.real.name);
  const suffixCandidate =
    matchingRepo.length === 1 &&
    realNameMatchesAllocatorSuffix(matchingRepo[0].name, args.real.name)
      ? matchingRepo[0]
      : undefined;
  const match = exact ?? suffixCandidate;
  if (!match) return null;
  if (match.id in args.pendingCreates) {
    return { placeholderId: match.id, from: "create" };
  }
  if (match.id in args.pendingForks) {
    return { placeholderId: match.id, from: "fork" };
  }
  return null;
}

function notifyBackendSelection(workspaceId: string | null) {
  notifyWorkspaceSelected(workspaceId).catch(() => {});
}

export type WorkspaceEnvironmentStatus = "idle" | "preparing" | "ready" | "error";

export interface WorkspaceEnvironmentPreparation {
  status: WorkspaceEnvironmentStatus;
  error?: string;
  /** Plugin currently running (e.g. "env-direnv") while `status ===
   *  "preparing"`. Cleared on transition to ready/idle so the UI
   *  doesn't keep showing a stale plugin name. */
  current_plugin?: string;
  /** `Date.now()` when the active plugin started. The UI ticks an
   *  elapsed counter off this so subscribers don't have to track
   *  their own timers. */
  started_at?: number;
}

export interface WorkspacesSlice {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  /** Repository "selected" at the project level — drives the project-scoped
   *  view rendered when no workspace is selected. Mutually exclusive with
   *  `selectedWorkspaceId`: setting one clears the other. */
  selectedRepositoryId: string | null;
  /** Repo id with a workspace creation currently in flight. Drives the
   *  sidebar's optimistic "preparing workspace…" placeholder row so that
   *  any caller (sidebar `+`, welcome card CTA, project-scoped CTA,
   *  Cmd+Shift+N hotkey) gives the same visual feedback. */
  creatingWorkspaceRepoId: string | null;
  setCreatingWorkspaceRepoId: (repoId: string | null) => void;
  /** Temporary placeholder workspace ids that map to an in-flight fork
   *  operation. The chat-side "Fork from here" action inserts a
   *  placeholder workspace into `workspaces`, selects it for instant
   *  navigation, and writes an entry here so the sidebar / chat panel
   *  can render a "preparing fork from <source>…" affordance while
   *  the backend snapshots and copies history. The placeholder is
   *  removed and replaced with the real workspace once
   *  `fork_workspace_at_checkpoint` resolves (or torn down on error).
   *
   *  Keyed by placeholder workspace id; the value is the source
   *  workspace's id (the row the user clicked Fork from), so the chat
   *  panel can show "Forking from <source.name>…" without re-walking
   *  the workspaces array. */
  pendingForks: Record<string, string>;
  beginPendingFork: (placeholder: Workspace, sourceWorkspaceId: string) => void;
  /** Resolve a pending fork: drop the placeholder row, add the real
   *  workspace, and move selection from the placeholder id to the
   *  real workspace id (only if the placeholder is still selected —
   *  if the user navigated away mid-fork, leave their selection
   *  alone). Bundled in one set() so the sidebar doesn't flash an
   *  empty selection between the two operations. */
  commitPendingFork: (placeholderId: string, real: Workspace) => void;
  /** Tear down a pending fork that failed (or was cancelled). Drops
   *  the placeholder row and restores selection to the supplied
   *  workspace id (typically the source the user was viewing before
   *  they clicked Fork). */
  cancelPendingFork: (placeholderId: string, restoreSelectionTo: string | null) => void;
  /** Temporary placeholder workspace ids that map to an in-flight
   *  workspace creation. Sibling of [`pendingForks`]: the sidebar `+`
   *  / welcome-card / Cmd+Shift+N orchestration inserts a placeholder
   *  workspace, selects it, and writes an entry here so the chat
   *  panel renders a "preparing workspace…" placard pointing at the
   *  in-flight worktree. Resolved by `commitPendingCreate` once
   *  `create_workspace` returns the real row, or torn down by
   *  `cancelPendingCreate` on error.
   *
   *  Keyed by placeholder workspace id; the value is the repo id the
   *  workspace was created against — used by the chat panel to
   *  render "Preparing workspace in <repo>…" without re-walking the
   *  repositories array. */
  pendingCreates: Record<string, string>;
  beginPendingCreate: (placeholder: Workspace) => void;
  /** Resolve a pending create: drop the placeholder row, add the
   *  real workspace, and move selection from the placeholder id to
   *  the real workspace id (only if the placeholder is still
   *  selected — if the user navigated away mid-create, leave their
   *  selection alone). Any provisioning output already written into
   *  the workspace's Claudette Terminal file stays on disk under the
   *  placeholder path — the real workspace's tab starts a fresh tail
   *  against its own file once env/setup writes there. */
  commitPendingCreate: (placeholderId: string, real: Workspace) => void;
  /** Tear down a pending create that failed. Drops the placeholder
   *  row and restores selection to the supplied workspace id
   *  (typically null since the user was on the placeholder when
   *  it failed). */
  cancelPendingCreate: (placeholderId: string, restoreSelectionTo: string | null) => void;
  workspaceEnvironment: Record<string, WorkspaceEnvironmentPreparation>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  removeWorkspace: (id: string) => void;
  selectWorkspace: (id: string | null) => void;
  /** Select (or clear) the project-scoped view. Setting a non-null id also
   *  clears any selected workspace so the project view replaces it. */
  selectRepository: (id: string | null) => void;
  /** Clear both workspace and repository selection in one shot. The global
   *  Dashboard is Claudette's default view; navigating to it shouldn't read
   *  as "back" because the dashboard isn't on a stack. Atomic so the UI
   *  doesn't transition through an intermediate single-cleared state. */
  goToDashboard: () => void;
  setWorkspaceEnvironment: (
    id: string,
    status: WorkspaceEnvironmentStatus,
    error?: string,
  ) => void;
  /** Update the per-workspace progress entry from a
   *  `workspace_env_progress` Tauri event. `plugin === null` clears
   *  the active plugin (paired with the matching `finished` event).
   *  Implicitly bumps `status` to `preparing` while plugins are
   *  running so the sidebar lights up regardless of which workspace
   *  the user has selected. */
  setWorkspaceEnvironmentProgress: (
    id: string,
    plugin: string | null,
    started_at?: number,
  ) => void;
}

export const createWorkspacesSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspacesSlice
> = (set) => ({
  workspaces: [],
  selectedWorkspaceId: null,
  selectedRepositoryId: null,
  creatingWorkspaceRepoId: null,
  setCreatingWorkspaceRepoId: (creatingWorkspaceRepoId) =>
    set({ creatingWorkspaceRepoId }),
  pendingForks: {},
  beginPendingFork: (placeholder, sourceWorkspaceId) =>
    set((s) => {
      // Insert the placeholder row and register it as a pending fork
      // in one atomic update so the sidebar can't render an instant
      // where the workspace exists but the spinner gate hasn't been
      // tripped yet. Also seed `workspaceEnvironment` to `preparing`
      // with a `started_at` of now so the sidebar's icon cascade
      // (which now gates on both `status === "preparing"` AND
      // `started_at != null`) immediately shows the spinner — the
      // backend's `workspace_env_progress` events will land against
      // the REAL workspace id later, not the placeholder, so we have
      // to drive the placeholder's progress entry ourselves.
      //
      // We deliberately do NOT call `notifyBackendSelection(placeholder.id)`
      // here: the backend would write the placeholder id into its
      // `selected_workspace_id` / `workspace_activity` maps (used by
      // SCM polling and tray menus), but the id has no backing DB
      // row, so the entries are orphaned and accumulate one per fork
      // attempt. Semantically, the backend's "selected workspace"
      // during the fork window remains the source (that's where
      // `fork_workspace_at_checkpoint` is operating), so leaving the
      // backend's view on the source is also accurate. The notify
      // fires with the real id once `commitPendingFork` swaps the
      // selection.
      //
      // Mirror the diff/preview/right-sidebar-tab state transitions
      // `selectWorkspace` performs so the placeholder navigation
      // doesn't leak the source workspace's diff selection or
      // sidebar tab state into the placeholder's view (and back out
      // again on commit/cancel). The placeholder has no open diff
      // tabs, so `restored`/`tabExists` collapse to "no restored
      // file" — but we still want to save the source's selection
      // into `diffSelectionByWorkspace` so returning to it on cancel
      // (or via commit's real-id swap, which inherits the source's
      // sidebar context for the placeholder's repo) preserves what
      // the user was looking at.
      const prev = s.selectedWorkspaceId;
      let selectionMap = s.diffSelectionByWorkspace;
      if (prev) {
        if (s.diffSelectedFile) {
          selectionMap = {
            ...selectionMap,
            [prev]: { path: s.diffSelectedFile, layer: s.diffSelectedLayer },
          };
        } else if (prev in selectionMap) {
          const next = { ...selectionMap };
          delete next[prev];
          selectionMap = next;
        }
      }
      return {
        workspaces: [...s.workspaces, placeholder],
        selectedWorkspaceId: placeholder.id,
        selectedRepositoryId: null,
        rightSidebarTab: "files",
        diffSelectionByWorkspace: selectionMap,
        diffSelectedFile: null,
        diffSelectedLayer: null,
        diffContent: null,
        diffError: null,
        diffPreviewMode: "diff",
        diffPreviewContent: null,
        diffPreviewLoading: false,
        diffPreviewError: null,
        diffMergeBase: null,
        pendingForks: {
          ...s.pendingForks,
          [placeholder.id]: sourceWorkspaceId,
        },
        workspaceEnvironment: {
          ...s.workspaceEnvironment,
          [placeholder.id]: {
            status: "preparing",
            started_at: Date.now(),
          },
        },
      };
    }),
  commitPendingFork: (placeholderId, real) =>
    set((s) => {
      const stillSelected = s.selectedWorkspaceId === placeholderId;
      // Drop the placeholder's pendingFork entry, swap the row, and
      // move selection only if the user hasn't navigated away. The
      // env-prep hook fires off the `selectedWorkspaceId` dep, so
      // flipping selection to the real id is what kicks off
      // `prepare_workspace_environment` for the actual worktree.
      const nextPendingForks = { ...s.pendingForks };
      delete nextPendingForks[placeholderId];
      // Dedupe: the backend emits `workspaces-changed` for the new
      // fork before returning its IPC response, so by the time we run
      // the real workspace is *usually* already in the store via
      // App.tsx's listener.  Naive `.concat(real)` would double-add
      // it.  Filter out both the placeholder and any pre-existing
      // real-id row, then re-add the freshest copy so the row's
      // fields (status_line, sort_order from `db.list_workspaces`,
      // etc.) reflect what the command actually returned.  Idempotent
      // either way: if the listener hasn't fired yet, only the
      // placeholder is filtered out.
      const filtered = s.workspaces.filter(
        (w) => w.id !== placeholderId && w.id !== real.id,
      );
      const nextWorkspaces = filtered.concat(real);
      const nextWorkspaceEnv = { ...s.workspaceEnvironment };
      delete nextWorkspaceEnv[placeholderId];
      if (stillSelected) {
        notifyBackendSelection(real.id);
      }
      return {
        workspaces: nextWorkspaces,
        pendingForks: nextPendingForks,
        selectedWorkspaceId: stillSelected ? real.id : s.selectedWorkspaceId,
        workspaceEnvironment: nextWorkspaceEnv,
      };
    }),
  cancelPendingFork: (placeholderId, restoreSelectionTo) =>
    set((s) => {
      const stillSelected = s.selectedWorkspaceId === placeholderId;
      const nextPendingForks = { ...s.pendingForks };
      delete nextPendingForks[placeholderId];
      const nextWorkspaceEnv = { ...s.workspaceEnvironment };
      delete nextWorkspaceEnv[placeholderId];
      if (stillSelected) {
        notifyBackendSelection(restoreSelectionTo);
      }
      return {
        workspaces: s.workspaces.filter((w) => w.id !== placeholderId),
        pendingForks: nextPendingForks,
        selectedWorkspaceId: stillSelected
          ? restoreSelectionTo
          : s.selectedWorkspaceId,
        workspaceEnvironment: nextWorkspaceEnv,
      };
    }),
  pendingCreates: {},
  beginPendingCreate: (placeholder) =>
    set((s) => {
      // Mirror `beginPendingFork` — insert the placeholder row, select
      // it, and seed `workspaceEnvironment` to "preparing" with a
      // `started_at` of now so the sidebar's icon cascade
      // (status === "preparing" + started_at != null →
      // WorkspaceEnvSpinner) immediately lights up. The backend's
      // `workspace_env_progress` events flow against the REAL id once
      // `commitPendingCreate` swaps that in, so the placeholder's
      // progress is driven from here.
      //
      // We deliberately do NOT call `notifyBackendSelection(placeholder.id)`:
      // the placeholder id has no DB row, so writing it into the
      // backend's selection / activity maps would orphan an entry per
      // attempted create. The real id gets notified on commit.
      //
      // Inline the diff/preview/right-sidebar resets that
      // `selectWorkspace` would normally perform so the placeholder
      // navigation doesn't leak the previously selected workspace's
      // file/diff context.
      const prev = s.selectedWorkspaceId;
      let selectionMap = s.diffSelectionByWorkspace;
      if (prev) {
        if (s.diffSelectedFile) {
          selectionMap = {
            ...selectionMap,
            [prev]: { path: s.diffSelectedFile, layer: s.diffSelectedLayer },
          };
        } else if (prev in selectionMap) {
          const next = { ...selectionMap };
          delete next[prev];
          selectionMap = next;
        }
      }
      return {
        workspaces: [...s.workspaces, placeholder],
        selectedWorkspaceId: placeholder.id,
        selectedRepositoryId: null,
        rightSidebarTab: "files",
        diffSelectionByWorkspace: selectionMap,
        diffSelectedFile: null,
        diffSelectedLayer: null,
        diffContent: null,
        diffError: null,
        diffPreviewMode: "diff",
        diffPreviewContent: null,
        diffPreviewLoading: false,
        diffPreviewError: null,
        diffMergeBase: null,
        pendingCreates: {
          ...s.pendingCreates,
          [placeholder.id]: placeholder.repository_id,
        },
        workspaceEnvironment: {
          ...s.workspaceEnvironment,
          [placeholder.id]: {
            status: "preparing",
            started_at: Date.now(),
          },
        },
      };
    }),
  commitPendingCreate: (placeholderId, real) =>
    set((s) => {
      const stillSelected = s.selectedWorkspaceId === placeholderId;
      const nextPendingCreates = { ...s.pendingCreates };
      delete nextPendingCreates[placeholderId];
      // Dedupe (same pattern as commitPendingFork): the backend's
      // `workspaces-changed` event may have already raced ahead of
      // the IPC response and inserted the real workspace via App.tsx's
      // listener. Filter both the placeholder AND any pre-existing
      // real-id row, then concat the freshest copy so the sidebar
      // never has two rows for the same workspace.
      const filtered = s.workspaces.filter(
        (w) => w.id !== placeholderId && w.id !== real.id,
      );
      const nextWorkspaces = filtered.concat(real);
      const nextWorkspaceEnv = { ...s.workspaceEnvironment };
      delete nextWorkspaceEnv[placeholderId];
      // Migrate the placeholder's env-prep entry to the real id when
      // the real id has no entry of its own yet — preserves the
      // "preparing" status + started_at so the chat composer / sidebar
      // stay in their loading state until the env-prep hook fires for
      // the real workspace and transitions to "ready". If the real
      // workspace already has its own env entry (a workspaces-changed
      // event arrived first and the env-prep hook beat us), trust
      // that one.
      if (!nextWorkspaceEnv[real.id]) {
        const ph = s.workspaceEnvironment[placeholderId];
        if (ph) nextWorkspaceEnv[real.id] = ph;
      }
      if (stillSelected) {
        notifyBackendSelection(real.id);
      }
      return {
        workspaces: nextWorkspaces,
        pendingCreates: nextPendingCreates,
        selectedWorkspaceId: stillSelected ? real.id : s.selectedWorkspaceId,
        workspaceEnvironment: nextWorkspaceEnv,
      };
    }),
  cancelPendingCreate: (placeholderId, restoreSelectionTo) =>
    set((s) => {
      const stillSelected = s.selectedWorkspaceId === placeholderId;
      const nextPendingCreates = { ...s.pendingCreates };
      delete nextPendingCreates[placeholderId];
      const nextWorkspaceEnv = { ...s.workspaceEnvironment };
      delete nextWorkspaceEnv[placeholderId];
      if (stillSelected) {
        notifyBackendSelection(restoreSelectionTo);
      }
      return {
        workspaces: s.workspaces.filter((w) => w.id !== placeholderId),
        pendingCreates: nextPendingCreates,
        selectedWorkspaceId: stillSelected
          ? restoreSelectionTo
          : s.selectedWorkspaceId,
        workspaceEnvironment: nextWorkspaceEnv,
      };
    }),
  workspaceEnvironment: {},
  setWorkspaces: (workspaces) => set({ workspaces }),
  // Idempotent by id: workspace creates can race between the Tauri
  // command's response (Sidebar calls `addWorkspace` after the await
  // resolves) and the `workspaces-changed` event the IPC hook emits.
  // Whichever fires first wins; the other becomes a merge-update so
  // the row never doubles in the sidebar.
  //
  // The merge preserves the existing `agent_status` ONLY when the
  // incoming row's lifecycle `status` matches the existing one. That
  // field isn't a database column — `db::list_workspaces` synthesizes
  // Idle (or Stopped for archived) on every read. The authoritative
  // value is normally the one already in the React store, set by
  // `useAgentStream` / `ChatPanel` from live agent events. Letting an
  // incoming row's synthetic Idle clobber a live "Running" leaves the
  // sidebar showing inactive for workspaces with active agents.
  //
  // BUT a `status` transition (Active→Archived, Archived→Active) is a
  // real lifecycle event whose synthetic agent_status IS authoritative —
  // an archive really does stop the agent (we kill the process inline
  // in `archive_workspace_inner`), so the incoming Stopped must win or
  // the sidebar lies about the row still being busy. Same logic in
  // reverse for restore. `updateWorkspace` remains the explicit-setter
  // path for callers that want to override agent_status directly.
  addWorkspace: (ws) =>
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === ws.id);
      if (idx === -1) {
        return { workspaces: [...s.workspaces, ws] };
      }
      const merged = [...s.workspaces];
      const existing = merged[idx];
      const statusChanged = existing.status !== ws.status;
      merged[idx] = statusChanged
        ? { ...existing, ...ws }
        : { ...existing, ...ws, agent_status: existing.agent_status };
      return { workspaces: merged };
    }),
  updateWorkspace: (id, updates) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates } : w,
      ),
    })),
  removeWorkspace: (id) =>
    set((s) => {
      const newUnreadCompletions = new Set(s.unreadCompletions);
      newUnreadCompletions.delete(id);
      // Drop all per-workspace terminal state for the removed workspace.
      // The cleanup effect in TerminalPanel watches `terminalTabs` and tears
      // down xterm instances and PTYs whose tab ids no longer exist in any
      // workspace; the other maps are value-keyed by workspace id.
      const orphanedTabIds = (s.terminalTabs[id] ?? []).map((t) => t.id);
      const newTerminalTabs = { ...s.terminalTabs };
      delete newTerminalTabs[id];
      const newActiveTerminalTabId = { ...s.activeTerminalTabId };
      delete newActiveTerminalTabId[id];
      const newWorkspaceTerminalCommands = { ...s.workspaceTerminalCommands };
      delete newWorkspaceTerminalCommands[id];
      const newPendingTerminalCommands = s.pendingTerminalCommands.filter(
        (cmd) => cmd.workspaceId !== id,
      );
      const newPaneTrees = { ...s.terminalPaneTrees };
      const newActivePane = { ...s.activeTerminalPaneId };
      for (const tabId of orphanedTabIds) {
        delete newPaneTrees[tabId];
        delete newActivePane[tabId];
      }
      const newDiffTabs = { ...s.diffTabsByWorkspace };
      delete newDiffTabs[id];
      const newDiffSelection = { ...s.diffSelectionByWorkspace };
      delete newDiffSelection[id];
      const newChatDrafts = { ...s.chatDrafts };
      for (const session of s.sessionsByWorkspace[id] ?? []) {
        delete newChatDrafts[session.id];
      }
      // Drop the unified workspace-tab order so a workspace id reused
      // later (e.g. restore-from-archive collision) starts from default
      // sessions→diffs→files layout instead of dredging up old entries.
      const newTabOrder = { ...s.tabOrderByWorkspace };
      delete newTabOrder[id];
      const newWorkspaceEnvironment = { ...s.workspaceEnvironment };
      delete newWorkspaceEnvironment[id];
      // Drop cached SCM state so the maps don't grow unboundedly and so a
      // workspace id reused later (restore-from-archive collision) can't
      // surface stale PR/CI data before the next poll completes. The
      // SQLite cache row is handled separately by the Rust archive path
      // (ON DELETE CASCADE on scm_status_cache, plus an explicit delete
      // in `archive_workspace_inner`).
      const newScmSummary = { ...s.scmSummary };
      delete newScmSummary[id];
      const newScmDetails = { ...s.scmDetails };
      delete newScmDetails[id];
      return {
        workspaces: s.workspaces.filter((w) => w.id !== id),
        selectedWorkspaceId:
          s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
        unreadCompletions: newUnreadCompletions,
        terminalTabs: newTerminalTabs,
        activeTerminalTabId: newActiveTerminalTabId,
        workspaceTerminalCommands: newWorkspaceTerminalCommands,
        pendingTerminalCommands: newPendingTerminalCommands,
        terminalPaneTrees: newPaneTrees,
        activeTerminalPaneId: newActivePane,
        diffTabsByWorkspace: newDiffTabs,
        diffSelectionByWorkspace: newDiffSelection,
        chatDrafts: newChatDrafts,
        tabOrderByWorkspace: newTabOrder,
        workspaceEnvironment: newWorkspaceEnvironment,
        scmSummary: newScmSummary,
        scmDetails: newScmDetails,
      };
    }),
  selectWorkspace: (id) =>
    set((s) => {
      if (id === s.selectedWorkspaceId) return s;
      notifyBackendSelection(id);

      // Save the outgoing workspace's active diff selection, or clear it if
      // the user left that workspace in chat view (e.g. they clicked a chat
      // tab, which nulls diffSelectedFile while leaving diff tabs open).
      // Without the explicit clear, a stale selection from an earlier diff
      // visit would resurrect the diff view on workspace return.
      const prev = s.selectedWorkspaceId;
      let selectionMap = s.diffSelectionByWorkspace;
      if (prev) {
        if (s.diffSelectedFile) {
          selectionMap = {
            ...selectionMap,
            [prev]: { path: s.diffSelectedFile, layer: s.diffSelectedLayer },
          };
        } else if (prev in selectionMap) {
          const next = { ...selectionMap };
          delete next[prev];
          selectionMap = next;
        }
      }

      // Restore incoming workspace's selection, validated against open tabs.
      const restored = id ? selectionMap[id] : undefined;
      const incomingTabs = id ? (s.diffTabsByWorkspace[id] ?? []) : [];
      const tabExists =
        restored?.path != null &&
        incomingTabs.some(
          (t) => t.path === restored.path && t.layer === restored.layer,
        );

      const updates: Partial<AppState> = {
        selectedWorkspaceId: id,
        // Selecting a workspace always wins over a project-scoped view.
        // We only clear when a workspace is being selected so explicit
        // `selectWorkspace(null)` (Back-to-Dashboard) preserves any
        // selectedRepositoryId the user already navigated to.
        selectedRepositoryId: id ? null : s.selectedRepositoryId,
        rightSidebarTab: "files",
        diffSelectionByWorkspace: selectionMap,
        diffSelectedFile: tabExists ? restored!.path : null,
        diffSelectedLayer: tabExists ? restored!.layer : null,
        diffContent: null,
        diffError: null,
        diffPreviewMode: "diff",
        diffPreviewContent: null,
        diffPreviewLoading: false,
        diffPreviewError: null,
        // diffMergeBase is a single global string keyed off whichever
        // workspace last set it. Clearing on switch prevents the file
        // viewer's git gutter (which reads diffMergeBase) from comparing
        // against the prior workspace's merge-base SHA when the right
        // sidebar is hidden — without this, RightSidebar's clearDiff()
        // never runs because the component isn't mounted, and the stale
        // SHA leaks across the boundary.
        diffMergeBase: null,
      };
      if (id) {
        const incoming = s.workspaces.find((w) => w.id === id);
        if (incoming) {
          updates.workspaceEnvironment = {
            ...s.workspaceEnvironment,
            [id]: {
              status: incoming.remote_connection_id ? "ready" : "preparing",
            },
          };
        }
      }
      if (id && s.unreadCompletions.has(id)) {
        const next = new Set(s.unreadCompletions);
        next.delete(id);
        updates.unreadCompletions = next;
      }
      return updates;
    }),
  selectRepository: (id) =>
    set((s) => {
      if (id === s.selectedRepositoryId && (id === null || !s.selectedWorkspaceId)) {
        // No-op when we're already in this exact state — avoids a needless
        // store mutation that would re-render every subscriber.
        return s;
      }
      // Picking a repository clears any selected workspace, so the backend
      // should drop its hot-tier focus too.
      if (id && s.selectedWorkspaceId) notifyBackendSelection(null);
      return {
        selectedRepositoryId: id,
        // Picking a project clears any open workspace so the project-scoped
        // view actually surfaces. Clearing the selection (id === null) leaves
        // the workspace alone — that's just "exit project view" semantics.
        selectedWorkspaceId: id ? null : s.selectedWorkspaceId,
      };
    }),
  goToDashboard: () =>
    set((s) => {
      if (s.selectedWorkspaceId === null && s.selectedRepositoryId === null) {
        return s;
      }
      if (s.selectedWorkspaceId) notifyBackendSelection(null);
      return { selectedWorkspaceId: null, selectedRepositoryId: null };
    }),
  setWorkspaceEnvironment: (id, status, error) =>
    set((s) => {
      // Always drop the per-plugin progress fields when the status is
      // explicitly set: "preparing" is set at the start of a fresh
      // resolve (any previous `current_plugin` / `started_at` belong
      // to a stale resolve and shouldn't carry over), and terminal
      // states (ready / error / idle) mean we're done so the sidebar/
      // composer/terminal must stop showing the "loading env-direnv
      // (Ns)…" hint. Live progress arrives via
      // `setWorkspaceEnvironmentProgress`, which is the only writer
      // that fills in those fields.
      return {
        workspaceEnvironment: {
          ...s.workspaceEnvironment,
          [id]: { status, error },
        },
      };
    }),
  setWorkspaceEnvironmentProgress: (id, plugin, started_at) =>
    set((s) => {
      const previous = s.workspaceEnvironment[id];
      // Only force-bump to "preparing" while a plugin is running. A
      // null plugin (the matching `finished` event) leaves the status
      // alone so the prepare-flow's resolve-then-status-update keeps
      // the final "ready" / "error" transition under its control.
      const status: WorkspaceEnvironmentStatus =
        plugin !== null ? "preparing" : (previous?.status ?? "idle");
      const entry: WorkspaceEnvironmentPreparation = {
        status,
        error: previous?.error,
        current_plugin: plugin ?? undefined,
        started_at: plugin !== null ? (started_at ?? Date.now()) : undefined,
      };
      return {
        workspaceEnvironment: {
          ...s.workspaceEnvironment,
          [id]: entry,
        },
      };
    }),
});
