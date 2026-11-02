import { useCallback } from "react";
import { useAppStore } from "../../stores/useAppStore";

/**
 * Read/write one transcript group's user collapse override from
 * `collapsedToolGroupsBySession`, falling back to `defaultCollapsed` until
 * the user toggles it. Keys come from `collapsedToolGroupKey`, which is
 * identical on both sides of the running→completed boundary, so a choice
 * made while a turn runs survives its finalization.
 *
 * Returns `[collapsed, setCollapsed]`. `setCollapsed` is a no-op for a
 * `null` key.
 */
export function useCollapsedToolGroup(
  sessionId: string,
  groupKey: string | null,
  defaultCollapsed: boolean,
): [boolean, (collapsed: boolean) => void] {
  const userOverride = useAppStore((s) =>
    groupKey ? s.collapsedToolGroupsBySession[sessionId]?.[groupKey] : undefined,
  );
  const setCollapsedToolGroup = useAppStore((s) => s.setCollapsedToolGroup);
  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      if (groupKey) setCollapsedToolGroup(sessionId, groupKey, collapsed);
    },
    [groupKey, sessionId, setCollapsedToolGroup],
  );
  return [userOverride ?? defaultCollapsed, setCollapsed];
}
