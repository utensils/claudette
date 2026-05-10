import { useEffect, useState } from "react";
import { useAppStore } from "../stores/useAppStore";

/**
 * Live-ticking elapsed-seconds counter for the per-workspace
 * env-prep loading state. Subscribes to `workspaceEnvironment[id]`
 * and re-renders once a second while the workspace is preparing,
 * yielding `Math.max(0, floor((Date.now() - started_at) / 1000))`.
 *
 * Returns `null` when the workspace isn't preparing or has no
 * `started_at` yet — callers can use this as a guard before
 * rendering the elapsed-time chip.
 *
 * Single-interval per consumer instead of a per-tick store update so
 * the sidebar's many subscribers don't thrash zustand on every second.
 */
export function useEnvElapsedSeconds(workspaceId: string | null): {
  plugin: string | null;
  seconds: number | null;
} {
  const entry = useAppStore((s) =>
    workspaceId ? s.workspaceEnvironment[workspaceId] : undefined,
  );
  const [now, setNow] = useState(() => Date.now());

  const isPreparing = entry?.status === "preparing" && entry.started_at;
  useEffect(() => {
    if (!isPreparing) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isPreparing]);

  if (!entry || !isPreparing || !entry.started_at) {
    return { plugin: null, seconds: null };
  }
  const seconds = Math.max(0, Math.floor((now - entry.started_at) / 1000));
  return {
    plugin: entry.current_plugin ?? null,
    seconds,
  };
}
