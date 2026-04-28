import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

export type PermissionLevel = "readonly" | "standard" | "full";

export interface PermissionsSlice {
  permissionLevel: Record<string, PermissionLevel>;
  setPermissionLevel: (wsId: string, level: PermissionLevel) => void;
}

export const createPermissionsSlice: StateCreator<
  AppState,
  [],
  [],
  PermissionsSlice
> = (set) => ({
  permissionLevel: {},
  setPermissionLevel: (wsId, level) =>
    set((s) => ({
      permissionLevel: { ...s.permissionLevel, [wsId]: level },
    })),
});
