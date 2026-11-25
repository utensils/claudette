import type { StateCreator } from "zustand";
import { getPendingSubagentControls, type SubagentControl } from "../../services/tauri/subagentRuns";
import { subagentSessionKey } from "../../types/subagent";
import { syncSessionAttention } from "./agentInteractionSlice";
import type { AppState } from "../useAppStore";

export interface SubagentControlsSlice {
  subagentControls: Record<string, SubagentControl[]>;
  updateSubagentControl: (connectionId: string | null, sessionId: string, toolId: string, control?: SubagentControl) => void;
  reloadSubagentControls: (connectionId: string | null, sessionId: string) => Promise<void>;
}

export const createSubagentControlsSlice: StateCreator<AppState, [], [], SubagentControlsSlice> = (set) => {
  // A live resolution can precede an older snapshot response even when the
  // control was never rendered on this client. Retain that removal in flight.
  const inFlight = new Map<string, Map<string, SubagentControl | undefined>>();
  return {
    subagentControls: {},
    updateSubagentControl: (connectionId, sessionId, toolId, control) => {
      const key = subagentSessionKey(connectionId, sessionId);
      inFlight.get(key)?.set(toolId, control);
      set((state) => {
        const controls = state.subagentControls[key] ?? [];
        const next = controls.filter((entry) => entry.tool_use_id !== toolId);
        if (control) next.push(control);
        if (!control && controls.length === next.length) return state;
        const subagentControls = { ...state.subagentControls, [key]: next };
        return { subagentControls, sessionsByWorkspace: syncSessionAttention(state, sessionId, { subagentControls }, connectionId) };
      });
    },
    reloadSubagentControls: async (connectionId, sessionId) => {
      const key = subagentSessionKey(connectionId, sessionId);
      const updates = new Map<string, SubagentControl | undefined>();
      inFlight.set(key, updates);
      try {
        const snapshot = await getPendingSubagentControls(sessionId, connectionId);
        if (inFlight.get(key) !== updates || !Array.isArray(snapshot)) return;
        const byId = new Map(snapshot.map((control) => [control.tool_use_id, control]));
        for (const [id, control] of updates) {
          if (control) byId.set(id, control);
          else byId.delete(id);
        }
        set((state) => {
          if (!byId.size && !state.subagentControls[key]?.length) return state;
          const subagentControls = { ...state.subagentControls, [key]: [...byId.values()] };
          return { subagentControls, sessionsByWorkspace: syncSessionAttention(state, sessionId, { subagentControls }, connectionId) };
        });
      } catch (error) {
        console.debug("Child approval snapshot unavailable", error);
      } finally {
        if (inFlight.get(key) === updates) inFlight.delete(key);
      }
    },
  };
};
