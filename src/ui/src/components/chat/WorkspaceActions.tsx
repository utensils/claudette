import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
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
import {
  preferredPrimaryApp,
  splitMenuApps,
} from "../../utils/workspaceAppsMenu";
import styles from "./WorkspaceActions.module.css";

interface WorkspaceActionsProps {
  worktreePath: string | null;
  disabled?: boolean;
}

// Time the pointer is allowed to travel between the "More" row and its
// flyout (or back) before the flyout closes — covers diagonal mouse paths.
const SUBMENU_GRACE_MS = 140;

// Render the icon directly rather than returning the lucide component
// constructor — `react-hooks/static-components` rejects assigning a
// component to a local variable inside render, since it can't see that
// the value is module-stable. Returning JSX here sidesteps that.
function renderCategoryIcon(category: AppCategory) {
  switch (category) {
    case "editor":
      return <Code2 size={14} strokeWidth={2.2} />;
    case "file_manager":
      return <FolderOpen size={14} strokeWidth={2.2} />;
    case "terminal":
      return <Terminal size={14} strokeWidth={2.2} />;
    case "ide":
      return <MonitorCog size={14} strokeWidth={2.2} />;
  }
}

export function AppIcon({ app }: { app: DetectedApp }) {
  if (app.icon_data_url) {
    return (
      <span
        className={styles.appIconImage}
        style={{ backgroundImage: `url(${app.icon_data_url})` }}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={`${styles.appIconFallback} ${styles[`appIcon_${app.category}`]}`}
      aria-hidden="true"
    >
      {renderCategoryIcon(app.category)}
    </span>
  );
}

export function WorkspaceActions({
  worktreePath,
  disabled = false,
}: WorkspaceActionsProps) {
  const { t } = useTranslation("chat");
  const detectedApps = useAppStore((s) => s.detectedApps);
  const workspaceAppsMenuShown = useAppStore((s) => s.workspaceAppsMenuShown);
  const addToast = useAppStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeSubmenuTimer = useRef<number | null>(null);

  const menuApps = useMemo(
    () => splitMenuApps(detectedApps, workspaceAppsMenuShown),
    [detectedApps, workspaceAppsMenuShown],
  );
  const primaryApp = useMemo(() => preferredPrimaryApp(menuApps), [menuApps]);
  const unavailable = disabled || !worktreePath;

  const clearCloseSubmenuTimer = useCallback(() => {
    if (closeSubmenuTimer.current !== null) {
      window.clearTimeout(closeSubmenuTimer.current);
      closeSubmenuTimer.current = null;
    }
  }, []);

  const scheduleCloseSubmenu = useCallback(() => {
    clearCloseSubmenuTimer();
    closeSubmenuTimer.current = window.setTimeout(() => {
      setMoreOpen(false);
      closeSubmenuTimer.current = null;
    }, SUBMENU_GRACE_MS);
  }, [clearCloseSubmenuTimer]);

  const openSubmenu = useCallback(() => {
    clearCloseSubmenuTimer();
    setMoreOpen(true);
  }, [clearCloseSubmenuTimer]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // This listener runs in the capture phase, ahead of the submenu's
        // own onKeyDown — so Escape has to peel back one layer at a time
        // here: collapse the "More" flyout first, then the whole menu.
        event.stopPropagation();
        if (moreOpen) {
          clearCloseSubmenuTimer();
          setMoreOpen(false);
        } else {
          setOpen(false);
        }
      }
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, moreOpen, clearCloseSubmenuTimer]);

  // Closing the outer menu (or losing the worktree) must also tear down the
  // "More" flyout and any pending close timer.
  useEffect(() => {
    if (!open) {
      setMoreOpen(false);
      clearCloseSubmenuTimer();
    }
  }, [open, clearCloseSubmenuTimer]);

  useEffect(() => clearCloseSubmenuTimer, [clearCloseSubmenuTimer]);

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

  const renderAppItem = (app: DetectedApp) => (
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
  );

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
          {menuApps.shown.map(renderAppItem)}
          {menuApps.more.length > 0 && (
            <div
              className={styles.moreItemWrap}
              onMouseEnter={openSubmenu}
              onMouseLeave={scheduleCloseSubmenu}
            >
              <button
                className={`${styles.menuItem} ${styles.menuItemMore}`}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                disabled={busyAction !== null}
                onClick={() => setMoreOpen((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "Enter") {
                    event.preventDefault();
                    openSubmenu();
                    const first =
                      submenuRef.current?.querySelector<HTMLButtonElement>(
                        "button",
                      );
                    first?.focus();
                  }
                }}
              >
                <span className={styles.menuItemMoreLabel}>
                  <span className={styles.utilityIcon} aria-hidden="true">
                    <SquareMenu size={14} strokeWidth={2.2} />
                  </span>
                  <span className={styles.menuItemLabel}>
                    {t("workspace_actions_more")}
                  </span>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
              {moreOpen && (
                <div
                  className={styles.submenu}
                  role="menu"
                  ref={submenuRef}
                  onMouseEnter={openSubmenu}
                  onMouseLeave={scheduleCloseSubmenu}
                  onKeyDown={(event) => {
                    // Escape is handled by the capture-phase window listener
                    // above; ArrowLeft collapses just the flyout.
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      event.stopPropagation();
                      clearCloseSubmenuTimer();
                      setMoreOpen(false);
                    }
                  }}
                >
                  {menuApps.more.map(renderAppItem)}
                </div>
              )}
            </div>
          )}
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
