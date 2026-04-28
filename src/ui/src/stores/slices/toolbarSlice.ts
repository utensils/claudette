import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

export interface ToolbarSlice {
  selectedModel: Record<string, string>;
  fastMode: Record<string, boolean>;
  thinkingEnabled: Record<string, boolean>;
  planMode: Record<string, boolean>;
  effortLevel: Record<string, string>;
  chromeEnabled: Record<string, boolean>;
  modelSelectorOpen: boolean;
  setSelectedModel: (wsId: string, model: string) => void;
  setFastMode: (wsId: string, enabled: boolean) => void;
  setThinkingEnabled: (wsId: string, enabled: boolean) => void;
  setPlanMode: (wsId: string, enabled: boolean) => void;
  setEffortLevel: (wsId: string, level: string) => void;
  setChromeEnabled: (wsId: string, enabled: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
}

export const createToolbarSlice: StateCreator<
  AppState,
  [],
  [],
  ToolbarSlice
> = (set) => ({
  selectedModel: {},
  fastMode: {},
  thinkingEnabled: {},
  planMode: {},
  effortLevel: {},
  chromeEnabled: {},
  modelSelectorOpen: false,
  setSelectedModel: (wsId, model) =>
    set((s) => ({
      selectedModel: { ...s.selectedModel, [wsId]: model },
    })),
  setFastMode: (wsId, enabled) =>
    set((s) => ({
      fastMode: { ...s.fastMode, [wsId]: enabled },
    })),
  setThinkingEnabled: (wsId, enabled) =>
    set((s) => ({
      thinkingEnabled: { ...s.thinkingEnabled, [wsId]: enabled },
    })),
  setPlanMode: (wsId, enabled) =>
    set((s) => ({
      planMode: { ...s.planMode, [wsId]: enabled },
    })),
  setEffortLevel: (wsId, level) =>
    set((s) => ({
      effortLevel: { ...s.effortLevel, [wsId]: level },
    })),
  setChromeEnabled: (wsId, enabled) =>
    set((s) => ({
      chromeEnabled: { ...s.chromeEnabled, [wsId]: enabled },
    })),
  setModelSelectorOpen: (open) => set({ modelSelectorOpen: open }),
});
