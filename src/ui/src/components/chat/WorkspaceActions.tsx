import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Code2,
  Copy,
  FolderOpen,
  MonitorCog,
  SquareMenu,
  Terminal,
} from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { openWorkspaceInApp } from "../../services/tauri";
import type { AppCategory, DetectedApp } from "../../types/apps";
import styles from "./WorkspaceActions.module.css";

interface WorkspaceActionsProps {
  worktreePath: string | null;
  disabled?: boolean;
}

const CATEGORY_ORDER: AppCategory[] = [
  "editor",
  "file_manager",
  "terminal",
  "ide",
];

function preferredPrimaryApp(apps: DetectedApp[]): DetectedApp | null {
  for (const category of CATEGORY_ORDER) {
    const app = apps.find((candidate) => candidate.category === category);
    if (app) return app;
  }
  return null;
}

function categoryIcon(category: AppCategory) {
  switch (category) {
    case "editor":
      return Code2;
    case "file_manager":
      return FolderOpen;
    case "terminal":
      return Terminal;
    case "ide":
      return MonitorCog;
  }
}

function AppIcon({ app }: { app: DetectedApp }) {
  if (app.icon_data_url) {
    return (
      <img
        className={styles.appIconImage}
        src={app.icon_data_url}
        alt=""
        aria-hidden="true"
      />
    );
  }

  const Icon = categoryIcon(app.category);
  return (
    <span
      className={`${styles.appIconFallback} ${styles[`appIcon_${app.category}`]}`}
      aria-hidden="true"
    >
      <Icon size={14} strokeWidth={2.2} />
    </span>
  );
}

export function WorkspaceActions({
  worktreePath,
  disabled = false,
}: WorkspaceActionsProps) {
  const { t } = useTranslation("chat");
  const detectedApps = useAppStore((s) => s.detectedApps);
  const addToast = useAppStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const apps = useMemo(
    () =>
      CATEGORY_ORDER.flatMap((category) =>
        detectedApps.filter((app) => app.category === category),
      ),
    [detectedApps],
  );
  const primaryApp = useMemo(() => preferredPrimaryApp(apps), [apps]);
  const unavailable = disabled || !worktreePath;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  const openApp = useCallback(
    async (app: DetectedApp) => {
      if (!worktreePath) return;
      setBusyAction(app.id);
      try {
        await openWorkspaceInApp(app.id, worktreePath);
        setOpen(false);
      } catch (err) {
        console.error(`Failed to open workspace in ${app.name}:`, err);
        addToast(t("workspace_actions_open_failed", { app: app.name }));
      } finally {
        setBusyAction(null);
      }
    },
    [addToast, t, worktreePath],
  );

  const copyPath = useCallback(async () => {
    if (!worktreePath) return;
    setBusyAction("copy-path");
    try {
      await writeText(worktreePath);
      addToast(t("workspace_actions_copied_path"));
      setOpen(false);
    } catch (err) {
      console.error("Failed to copy workspace path:", err);
      addToast(t("workspace_actions_copy_failed"));
    } finally {
      setBusyAction(null);
    }
  }, [addToast, t, worktreePath]);

  const primaryTitle = primaryApp
    ? t("workspace_actions_open_in", { app: primaryApp.name })
    : t("workspace_actions_no_apps");
  const menuDisabled = unavailable;

  return (
    <div className={styles.container} ref={containerRef}>
      <div className={styles.splitButton}>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={unavailable || !primaryApp || busyAction !== null}
          title={primaryTitle}
          aria-label={primaryTitle}
          onClick={() => {
            if (primaryApp) void openApp(primaryApp);
          }}
        >
          {primaryApp ? <AppIcon app={primaryApp} /> : <SquareMenu size={14} />}
        </button>
        <button
          className={styles.menuButton}
          type="button"
          disabled={menuDisabled || busyAction !== null}
          title={t("workspace_actions_menu")}
          aria-label={t("workspace_actions_menu")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <div className={styles.menu} role="menu">
          {apps.map((app) => (
            <button
              className={styles.menuItem}
              type="button"
              role="menuitem"
              key={app.id}
              disabled={busyAction !== null}
              onClick={() => void openApp(app)}
            >
              <AppIcon app={app} />
              <span className={styles.menuItemLabel}>{app.name}</span>
            </button>
          ))}
          <div className={styles.utilityGroup}>
            <button
              className={styles.menuItem}
              type="button"
              role="menuitem"
              disabled={busyAction !== null || !worktreePath}
              onClick={() => void copyPath()}
            >
              <span className={styles.utilityIcon} aria-hidden="true">
                <Copy size={14} strokeWidth={2.2} />
              </span>
              <span className={styles.menuItemLabel}>
                {t("workspace_actions_copy_path")}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
