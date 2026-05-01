import { useMemo } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../stores/useAppStore";
import { openWorkspaceInApp } from "../../services/tauri";
import { HeaderMenu } from "./HeaderMenu";

interface WorkspaceActionsProps {
  worktreePath: string | null;
  disabled?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  editor: "Editors",
  terminal: "Terminals",
  ide: "IDEs",
};

const CATEGORY_ORDER = ["editor", "terminal", "ide"] as const;

export function WorkspaceActions({
  worktreePath,
  disabled = false,
}: WorkspaceActionsProps) {
  const detectedApps = useAppStore((s) => s.detectedApps);

  const items = useMemo(() => {
    const menuItems: { value: string; label: string; group?: string }[] = [];

    for (const category of CATEGORY_ORDER) {
      const apps = detectedApps.filter((a) => a.category === category);
      const groupLabel = CATEGORY_LABELS[category];
      for (const app of apps) {
        menuItems.push({
          value: `open:${app.id}`,
          label: `Open in ${app.name}`,
          group: groupLabel,
        });
      }
    }

    menuItems.push({
      value: "copy-path",
      label: "Copy Path",
      group: "Other",
    });

    return menuItems;
  }, [detectedApps]);

  const handleSelect = async (action: string) => {
    if (!worktreePath) return;

    if (action.startsWith("open:")) {
      const appId = action.slice(5);
      try {
        await openWorkspaceInApp(appId, worktreePath);
      } catch (err) {
        console.error(`Failed to open in app ${appId}:`, err);
      }
    } else if (action === "copy-path") {
      try {
        await writeText(worktreePath);
      } catch (err) {
        console.error("Failed to copy path:", err);
      }
    }
  };

  return (
    <HeaderMenu
      label="Actions"
      items={items}
      disabled={disabled || !worktreePath}
      title="Workspace actions"
      onSelect={handleSelect}
    />
  );
}
