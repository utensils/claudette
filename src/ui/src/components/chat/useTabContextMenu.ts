import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { statusForOpenFileTab } from "../files/fileTreeStatus";
import type { AttachmentContextMenuItem } from "./AttachmentContextMenu";
import { closeScopeForTabContext, type NavEntry } from "./sessionTabsLogic";
import type { StagedDiffFiles } from "../../types";

interface UseTabContextMenuArgs {
  navEntries: NavEntry[];
  navEntryByKey: Map<string, NavEntry>;
  diffStagedFiles: StagedDiffFiles | null;
  closeEntries: (entries: NavEntry[]) => Promise<void>;
  selectEntry: (entry: NavEntry) => void;
}

/**
 * Right-click menu state + items for the workspace tab strip. Tracks which
 * tab was clicked (by its NavEntry key) and the click position; the caller
 * renders the menu once, portal'd to body so tab-strip overflow doesn't
 * clip it.
 */
export function useTabContextMenu({
  navEntries,
  navEntryByKey,
  diffStagedFiles,
  closeEntries,
  selectEntry,
}: UseTabContextMenuArgs) {
  const { t } = useTranslation("chat");
  const [contextMenu, setContextMenu] = useState<
    { entryKey: string; x: number; y: number } | null
  >(null);

  const openContextMenu = useCallback(
    (entryKey: string, x: number, y: number) => {
      setContextMenu({ entryKey, x, y });
    },
    [setContextMenu],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Build the menu items lazily from the entry that was right-clicked. The
  // unified navEntries order is what "to the right" / "others" resolve against,
  // matching the order the user sees in the strip.
  const contextMenuItems = useMemo<AttachmentContextMenuItem[] | null>(() => {
    if (!contextMenu) return null;
    const idx = navEntries.findIndex((e) => e.key === contextMenu.entryKey);
    if (idx < 0) return null;
    const target = navEntries[idx];
    const closeScope = closeScopeForTabContext(
      navEntries,
      target.key,
      (entry) =>
        entry.kind === "diff" &&
        statusForOpenFileTab(entry.path, diffStagedFiles) === "Deleted",
    );
    const scopedIdx = closeScope.findIndex((e) => e.key === target.key);
    const others = closeScope.filter((_, i) => i !== scopedIdx);
    const toRight = closeScope.slice(scopedIdx + 1);
    return [
      { label: t("tab_close"), onSelect: () => void closeEntries([target]) },
      {
        label: t("tab_close_others"),
        onSelect: async () => {
          await closeEntries(others);
          selectEntry(target);
        },
        disabled: others.length === 0,
      },
      {
        label: t("tab_close_to_right"),
        onSelect: async () => {
          await closeEntries(toRight);
          selectEntry(target);
        },
        disabled: toRight.length === 0,
      },
      { label: t("tab_close_all"), onSelect: () => void closeEntries(navEntries) },
    ];
  }, [contextMenu, diffStagedFiles, navEntries, closeEntries, selectEntry, t]);

  const contextMenuEntry = contextMenu
    ? (navEntryByKey.get(contextMenu.entryKey) ?? null)
    : null;

  return {
    contextMenu,
    contextMenuItems,
    contextMenuEntry,
    openContextMenu,
    closeContextMenu,
  };
}
