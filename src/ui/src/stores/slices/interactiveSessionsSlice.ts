// G7 — Store slice tracking persisted interactive-session rows per
// workspace. The Sidebar consumes this via `computeInteractiveBadgeState`
// (see `components/sidebar/InteractiveBadge.tsx`) to render the
// Awaiting / Detached / Crashed badges next to workspace rows.
//
// The slice is intentionally minimal in G7: it just holds the rows
// keyed by workspace id and exposes a setter. A future change can
// add an `awaitingByWorkspace` map (live signal from the per-turn
// assembler in ChatPanel) to enrich the badge for the currently-open
// workspace; the slice's shape already accommodates that by keeping
// the raw rows separate from any derived signal.
//
// Wiring (G7 v1):
//   - Slice is registered in `useAppStore.ts`.
//   - Sidebar.tsx reads `interactiveSessionsByWorkspace` and renders
//     the badge.
//   - No automatic data loader is wired yet — population of the map
//     (calling `listInteractive(workspaceId)` on workspace open /
//     interactive event arrival) is deferred to a follow-up. Until
//     that lands, the map is empty and no badge renders, which is
//     the correct fallback ("rendering a workspace WITHOUT an
//     interactive session shows no badge").

import type { StateCreator } from "zustand";
import type { InteractiveSessionRow } from "../../services/interactive";
import type { AppState } from "../useAppStore";

export interface InteractiveSessionsSlice {
  /** Persisted `interactive_sessions` rows keyed by workspace id.
   *  Empty / missing entries mean "no interactive sessions for this
   *  workspace" — the sidebar selector treats undefined and `[]`
   *  identically. */
  interactiveSessionsByWorkspace: Record<string, InteractiveSessionRow[]>;

  /** Replace the row list for one workspace. Typically called after
   *  a `listInteractive(workspaceId)` resolves. */
  setInteractiveSessionsForWorkspace: (
    workspaceId: string,
    sessions: InteractiveSessionRow[],
  ) => void;

  /** Drop the row list for one workspace (e.g. when the workspace is
   *  deleted). */
  clearInteractiveSessionsForWorkspace: (workspaceId: string) => void;
}

export const createInteractiveSessionsSlice: StateCreator<
  AppState,
  [],
  [],
  InteractiveSessionsSlice
> = (set) => ({
  interactiveSessionsByWorkspace: {},
  setInteractiveSessionsForWorkspace: (workspaceId, sessions) =>
    set((s) => ({
      interactiveSessionsByWorkspace: {
        ...s.interactiveSessionsByWorkspace,
        [workspaceId]: sessions,
      },
    })),
  clearInteractiveSessionsForWorkspace: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.interactiveSessionsByWorkspace)) return s;
      const next = { ...s.interactiveSessionsByWorkspace };
      delete next[workspaceId];
      return { interactiveSessionsByWorkspace: next };
    }),
});
