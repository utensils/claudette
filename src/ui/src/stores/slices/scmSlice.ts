import type { StateCreator } from "zustand";
import type { ScmDetail, ScmSummary } from "../../types/plugin";
import type { AppState } from "../useAppStore";

export interface ScmSlice {
  scmSummary: Record<string, ScmSummary>;
  scmDetail: ScmDetail | null;
  scmDetailLoading: boolean;
  setScmSummary: (wsId: string, summary: ScmSummary) => void;
  setScmDetail: (detail: ScmDetail | null) => void;
  setScmDetailLoading: (loading: boolean) => void;
}

export const createScmSlice: StateCreator<AppState, [], [], ScmSlice> = (
  set,
) => ({
  scmSummary: {},
  scmDetail: null,
  scmDetailLoading: false,
  setScmSummary: (wsId, summary) =>
    set((s) => ({
      scmSummary: { ...s.scmSummary, [wsId]: summary },
    })),
  setScmDetail: (detail) => set({ scmDetail: detail }),
  setScmDetailLoading: (loading) => set({ scmDetailLoading: loading }),
});
