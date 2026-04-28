import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

const toastTimers = new Map<string, number>();

export interface NotificationsSlice {
  unreadCompletions: Set<string>; // workspace IDs with unread completions
  markWorkspaceAsUnread: (wsId: string) => void;
  clearUnreadCompletion: (wsId: string) => void;

  toasts: { id: string; message: string }[];
  addToast: (message: string) => void;
  removeToast: (id: string) => void;
}

export const createNotificationsSlice: StateCreator<
  AppState,
  [],
  [],
  NotificationsSlice
> = (set) => ({
  unreadCompletions: new Set<string>(),
  markWorkspaceAsUnread: (wsId) =>
    set((s) => {
      const newSet = new Set(s.unreadCompletions);
      newSet.add(wsId);
      return { unreadCompletions: newSet };
    }),
  clearUnreadCompletion: (wsId) =>
    set((s) => {
      const newSet = new Set(s.unreadCompletions);
      newSet.delete(wsId);
      return { unreadCompletions: newSet };
    }),

  toasts: [],
  addToast: (message) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    const handle = window.setTimeout(() => {
      toastTimers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
    toastTimers.set(id, handle);
  },
  removeToast: (id) => {
    const handle = toastTimers.get(id);
    if (handle != null) {
      window.clearTimeout(handle);
      toastTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
});
