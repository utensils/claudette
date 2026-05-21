import { useEffect, useState } from "react";
import { useAppStore } from "../stores/useAppStore";

export function useWorkspaceElapsedSeconds(
  workspaceId: string | null | undefined,
  isRunning: boolean,
): number {
  const promptStartTime = useAppStore((s) =>
    workspaceId ? s.promptStartTime[workspaceId] ?? null : null,
  );
  const setPromptStartTime = useAppStore((s) => s.setPromptStartTime);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!workspaceId || !isRunning) {
      setElapsed(0);
      return;
    }

    const startTime = promptStartTime ?? Date.now();
    if (promptStartTime == null) {
      setPromptStartTime(workspaceId, startTime);
    }

    const updateElapsed = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [isRunning, promptStartTime, setPromptStartTime, workspaceId]);

  return elapsed;
}
