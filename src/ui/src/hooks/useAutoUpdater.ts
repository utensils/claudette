import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import { isAgentBusy } from "../utils/agentStatus";
import {
  checkForUpdatesWithChannel,
  installPendingUpdate,
  getAppSetting,
  setAppSetting,
  type UpdateChannel,
} from "../services/tauri";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export type UpdateCheckResult = "available" | "up-to-date" | "error";

/** Check the updater endpoint for the active channel and update Zustand state. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const channel = useAppStore.getState().updateChannel;
  try {
    const update = await checkForUpdatesWithChannel(channel);
    if (update) {
      useAppStore.getState().setUpdateAvailable(true, update.version);
      return "available";
    } else {
      useAppStore.getState().setUpdateAvailable(false, null);
      return "up-to-date";
    }
  } catch (e) {
    console.error("[updater] Check failed:", e);
    return "error";
  }
}

export async function installNow(): Promise<void> {
  const store = useAppStore.getState();
  if (store.updateDownloading) return;
  if (!store.updateAvailable) return;

  store.setUpdateDownloading(true);
  store.setUpdateProgress(0);

  try {
    await installPendingUpdate();
    // The Rust side calls app.restart() after install completes, so this
    // line typically isn't reached. If it is (e.g. install failed silently),
    // fall through to the catch on the next tick.
  } catch (e) {
    console.error("[updater] Install failed:", e);
    const s = useAppStore.getState();
    s.setUpdateDownloading(false);
    s.setUpdateProgress(0);
    s.setUpdateError(String(e));
  }
}

/**
 * User-initiated retry after a failed install. The Rust side `take()`s the
 * pending update on the previous attempt, so we must re-run the check to
 * repopulate it before another install can succeed.
 */
export async function retryInstall(): Promise<void> {
  useAppStore.getState().setUpdateError(null);
  const result = await checkForUpdate();
  if (result === "available") await installNow();
}

export function installWhenIdle(): void {
  const hasRunning = useAppStore.getState().workspaces.some(
    (ws) => isAgentBusy(ws.agent_status)
  );
  if (!hasRunning) {
    installNow();
    return;
  }
  useAppStore.getState().setUpdateInstallWhenIdle(true);
  useAppStore.getState().setUpdateDismissed(true);
}

export function dismiss(): void {
  useAppStore.getState().setUpdateDismissed(true);
}

/**
 * Apply a channel change: persist it, update store state, and trigger a fresh
 * check against the new endpoint. Used by the Settings UI and the
 * Nightly-confirmation modal.
 */
export async function applyUpdateChannel(channel: UpdateChannel): Promise<void> {
  await setAppSetting("update_channel", channel);
  useAppStore.getState().setUpdateChannel(channel);
  // Don't await — the banner state will update when the check returns.
  checkForUpdate();
}

/** Read the persisted channel into the store. Returns the resolved channel. */
export async function loadUpdateChannel(): Promise<UpdateChannel> {
  let channel: UpdateChannel = "stable";
  try {
    const stored = await getAppSetting("update_channel");
    if (stored === "nightly") channel = "nightly";
  } catch (e) {
    console.error("[updater] Failed to load update_channel setting:", e);
  }
  // Set even when channel matches the default — this resets cached state and
  // ensures the store reflects the persisted value before the first check.
  useAppStore.getState().setUpdateChannel(channel);
  return channel;
}

export function useAutoUpdater() {
  const updateInstallWhenIdle = useAppStore((s) => s.updateInstallWhenIdle);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const hasRunningAgents = useAppStore(
    (s) => s.workspaces.some((ws) => isAgentBusy(ws.agent_status))
  );

  // Subscribe to the Rust-side download progress event.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<number>("updater://progress", (event) => {
      useAppStore.getState().setUpdateProgress(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        console.error("[updater] Failed to subscribe to progress events:", e);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Load persisted channel, then start the check loop. Loading first avoids a
  // wasted check against the default ("stable") before the persisted ("nightly")
  // arrives.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let intervalId: number | undefined;
    let cancelled = false;
    loadUpdateChannel().then(() => {
      if (cancelled) return;
      checkForUpdate();
      intervalId = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    });
    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (updateInstallWhenIdle && updateAvailable && !hasRunningAgents) {
      installNow();
    }
  }, [updateInstallWhenIdle, updateAvailable, hasRunningAgents]);
}
