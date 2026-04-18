import { useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "../stores/useAppStore";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Module-level storage so both the hook and external callers (e.g. Settings)
// share the same Update handle.
let pendingUpdate: Update | null = null;

export type UpdateCheckResult = "available" | "up-to-date" | "error";

/** Check the updater endpoint and update Zustand state. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      useAppStore.getState().setUpdateAvailable(true, update.version);
      return "available";
    } else {
      pendingUpdate = null;
      useAppStore.getState().setUpdateAvailable(false, null);
      return "up-to-date";
    }
  } catch (e) {
    console.error("[updater] Check failed:", e);
    return "error";
  }
}

export async function installNow(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;
  if (useAppStore.getState().updateDownloading) return;

  useAppStore.getState().setUpdateDownloading(true);
  useAppStore.getState().setUpdateProgress(0);

  let totalBytes = 0;
  let downloadedBytes = 0;

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalBytes = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes > 0) {
          useAppStore.getState().setUpdateProgress(
            Math.round((downloadedBytes / totalBytes) * 100)
          );
        }
      } else if (event.event === "Finished") {
        useAppStore.getState().setUpdateProgress(100);
      }
    });
    await relaunch();
  } catch (e) {
    console.error("[updater] Install failed:", e);
    useAppStore.getState().setUpdateDownloading(false);
    useAppStore.getState().setUpdateProgress(0);
    checkForUpdate();
  }
}

export function installWhenIdle(): void {
  const hasRunning = useAppStore.getState().workspaces.some(
    (ws) => ws.agent_status === "Running"
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

export function useAutoUpdater() {
  useEffect(() => {
    if (import.meta.env.DEV) return;

    checkForUpdate();
    const intervalId = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  const updateInstallWhenIdle = useAppStore((s) => s.updateInstallWhenIdle);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const hasRunningAgents = useAppStore(
    (s) => s.workspaces.some((ws) => ws.agent_status === "Running")
  );

  useEffect(() => {
    if (updateInstallWhenIdle && updateAvailable && !hasRunningAgents) {
      installNow();
    }
  }, [updateInstallWhenIdle, updateAvailable, hasRunningAgents, installNow]);
}
