import type { StateCreator } from "zustand";
import type { ScmDetail, ScmSummary } from "../../types/plugin";
import type { AppState } from "../useAppStore";

export interface ScmSlice {
  scmSummary: Record<string, ScmSummary>;
  /** Full PR+CI detail keyed by workspace_id. Populated at boot from SQLite
   *  cache and kept fresh by background polling events — so workspace switches
   *  can show instant state without a network round-trip. */
  scmDetails: Record<string, ScmDetail>;
  scmDetailLoading: boolean;
  setScmSummary: (wsId: string, summary: ScmSummary) => void;
  setScmDetail: (detail: ScmDetail) => void;
  setScmDetailLoading: (loading: boolean) => void;
}

export const createScmSlice: StateCreator<AppState, [], [], ScmSlice> = (
  set,
) => ({
  scmSummary: {},
  scmDetails: {},
  scmDetailLoading: false,
  setScmSummary: (wsId, summary) =>
    set((s) => ({
      scmSummary: { ...s.scmSummary, [wsId]: summary },
    })),
  setScmDetail: (detail) =>
    set((s) => ({
      scmDetails: { ...s.scmDetails, [detail.workspace_id]: detail },
    })),
  setScmDetailLoading: (loading) => set({ scmDetailLoading: loading }),
});
