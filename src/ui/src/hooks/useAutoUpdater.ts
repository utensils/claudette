import { useEffect, useRef, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "../stores/useAppStore";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function useAutoUpdater() {
  const updateRef = useRef<Update | null>(null);

  const setUpdateAvailable = useAppStore((s) => s.setUpdateAvailable);
  const setUpdateDismissed = useAppStore((s) => s.setUpdateDismissed);
  const setUpdateInstallWhenIdle = useAppStore((s) => s.setUpdateInstallWhenIdle);
  const setUpdateDownloading = useAppStore((s) => s.setUpdateDownloading);
  const setUpdateProgress = useAppStore((s) => s.setUpdateProgress);

  const checkForUpdate = useCallback(async () => {
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setUpdateAvailable(true, update.version);
      }
    } catch (e) {
      console.error("[updater] Check failed:", e);
    }
  }, [setUpdateAvailable]);

  const installNow = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setUpdateDownloading(true);
    setUpdateProgress(0);

    let totalBytes = 0;
    let downloadedBytes = 0;

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            setUpdateProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      await relaunch();
    } catch (e) {
      console.error("[updater] Install failed:", e);
      setUpdateDownloading(false);
      setUpdateProgress(0);
    }
  }, [setUpdateDownloading, setUpdateProgress]);

  const installWhenIdle = useCallback(() => {
    setUpdateInstallWhenIdle(true);
    setUpdateDismissed(true);
  }, [setUpdateInstallWhenIdle, setUpdateDismissed]);

  const dismiss = useCallback(() => {
    setUpdateDismissed(true);
  }, [setUpdateDismissed]);

  // Periodic update checks.
  useEffect(() => {
    checkForUpdate();
    const intervalId = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [checkForUpdate]);

  // Install when idle: watch for all agents to stop running.
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

  return { installNow, installWhenIdle, dismiss };
}
