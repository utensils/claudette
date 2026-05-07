import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

export interface ChatTurnSettings {
  // Keyed by chat session id, matching every existing consumer
  // (ChatToolbar, ComposerToolbar, ChatPanel, ChatInputArea). The slice's
  // record name says "workspace" historically but the real key is the
  // session — toolbar state is per-conversation, not per-worktree.
  chatSessionId: string;
  model: string | null;
  backendId: string | null;
  fastMode: boolean;
  thinkingEnabled: boolean;
  planMode: boolean;
  effort: string | null;
  chromeEnabled: boolean;
}

export interface ToolbarSlice {
  selectedModel: Record<string, string>;
  selectedModelProvider: Record<string, string>;
  fastMode: Record<string, boolean>;
  thinkingEnabled: Record<string, boolean>;
  planMode: Record<string, boolean>;
  effortLevel: Record<string, string>;
  chromeEnabled: Record<string, boolean>;
  modelSelectorOpen: boolean;
  setSelectedModel: (wsId: string, model: string, providerId?: string) => void;
  setSelectedModelProvider: (wsId: string, providerId: string) => void;
  setFastMode: (wsId: string, enabled: boolean) => void;
  setThinkingEnabled: (wsId: string, enabled: boolean) => void;
  setPlanMode: (wsId: string, enabled: boolean) => void;
  setEffortLevel: (wsId: string, level: string) => void;
  setChromeEnabled: (wsId: string, enabled: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
  applyChatTurnSettings: (settings: ChatTurnSettings) => void;
}

export const createToolbarSlice: StateCreator<
  AppState,
  [],
  [],
  ToolbarSlice
> = (set) => ({
  selectedModel: {},
  selectedModelProvider: {},
  fastMode: {},
  thinkingEnabled: {},
  planMode: {},
  effortLevel: {},
  chromeEnabled: {},
  modelSelectorOpen: false,
  setSelectedModel: (wsId, model, providerId) =>
    set((s) => ({
      selectedModel: { ...s.selectedModel, [wsId]: model },
      selectedModelProvider: providerId
        ? { ...s.selectedModelProvider, [wsId]: providerId }
        : s.selectedModelProvider,
    })),
  setSelectedModelProvider: (wsId, providerId) =>
    set((s) => ({
      selectedModelProvider: { ...s.selectedModelProvider, [wsId]: providerId },
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
  // Apply settings reported by the backend after a turn lands. Booleans are
  // always part of the resolved AgentSettings (false ≠ "unset"), so they
  // always overwrite. `model` and `effort` are optional overrides — if null,
  // the agent fell back to a workspace/global default we don't know here, so
  // we leave the existing toolbar selection alone rather than pretending the
  // user picked the default.
  applyChatTurnSettings: ({
    chatSessionId,
    model,
    backendId,
    fastMode,
    thinkingEnabled,
    planMode,
    effort,
    chromeEnabled,
  }) =>
    set((s) => {
      const next: Partial<ToolbarSlice> = {
        fastMode: { ...s.fastMode, [chatSessionId]: fastMode },
        thinkingEnabled: { ...s.thinkingEnabled, [chatSessionId]: thinkingEnabled },
        planMode: { ...s.planMode, [chatSessionId]: planMode },
        chromeEnabled: { ...s.chromeEnabled, [chatSessionId]: chromeEnabled },
      };
      if (model !== null) {
        next.selectedModel = { ...s.selectedModel, [chatSessionId]: model };
      }
      if (backendId !== null) {
        next.selectedModelProvider = { ...s.selectedModelProvider, [chatSessionId]: backendId };
      }
      if (effort !== null) {
        next.effortLevel = { ...s.effortLevel, [chatSessionId]: effort };
      }
      return next;
    }),
});
