import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { deleteAppSetting, setAppSetting } from "../../../services/tauri";
import { splitMenuApps } from "../../../utils/workspaceAppsMenu";
import { AppIcon } from "../../chat/WorkspaceActions";
import { DefaultTerminalSetting } from "./DefaultTerminalSetting";
import settings from "../Settings.module.css";
import styles from "./AppsSettings.module.css";

const WORKSPACE_APPS_MENU_SETTING_KEY = "workspace_apps_menu";

export function AppsSettings() {
  const { t } = useTranslation("settings");
  const detectedApps = useAppStore((s) => s.detectedApps);
  const shownIds = useAppStore((s) => s.workspaceAppsMenuShown);
  const setShownIds = useAppStore((s) => s.setWorkspaceAppsMenuShown);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const { shown, more } = useMemo(
    () => splitMenuApps(detectedApps, shownIds),
    [detectedApps, shownIds],
  );
  const customized = Array.isArray(shownIds);

  // Persist a new ordered allowlist (null = "reset to show everything").
  const persist = async (next: string[] | null) => {
    if (pending) return;
    const previous = shownIds;
    setShownIds(next);
    setPending(true);
    try {
      setError(null);
      if (next === null) {
        await deleteAppSetting(WORKSPACE_APPS_MENU_SETTING_KEY);
      } else {
        await setAppSetting(
          WORKSPACE_APPS_MENU_SETTING_KEY,
          JSON.stringify({ shown: next }),
        );
      }
    } catch (e) {
      setShownIds(previous);
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  const currentShownIds = () => shown.map((app) => app.id);

  const removeFromMenu = (id: string) =>
    void persist(currentShownIds().filter((appId) => appId !== id));

  const addToMenu = (id: string) => void persist([...currentShownIds(), id]);

  const moveBy = (index: number, delta: number) => {
    const ids = currentShownIds();
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void persist(ids);
  };

  const resetToDefault = () => void persist(null);

  // Show the reset affordance whenever there's something to reset (apps
  // detected, or a stale customization persisted from a run where there were).
  const showResetRow = detectedApps.length > 0 || customized;

  return (
    <div>
      <h2 className={settings.sectionTitle}>{t("apps_title")}</h2>

      {error && <div className={settings.error}>{error}</div>}

      <DefaultTerminalSetting />

      <div className={settings.fieldGroup}>
        <div className={settings.fieldLabel}>{t("apps_menu_label")}</div>
        <div className={`${settings.fieldHint} ${settings.fieldHintSpacedWide}`}>
          {t("apps_menu_desc")}
        </div>

        {detectedApps.length === 0 ? (
          <div className={styles.listEmpty}>{t("apps_menu_empty")}</div>
        ) : (
          <div className={styles.lists}>
            <div className={styles.list}>
              <div className={styles.listHeader}>
                {t("apps_menu_shown_heading")}
              </div>
              <div className={styles.listBody}>
                {shown.length === 0 && (
                  <div className={styles.listEmpty}>
                    {t("apps_menu_shown_empty")}
                  </div>
                )}
                {shown.map((app, index) => (
                  <div className={styles.appRow} key={app.id}>
                    <AppIcon app={app} />
                    <span className={styles.appRowName}>{app.name}</span>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        disabled={pending || index === 0}
                        aria-label={t("apps_menu_move_up", { app: app.name })}
                        title={t("apps_menu_move_up", { app: app.name })}
                        onClick={() => moveBy(index, -1)}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        className={styles.iconButton}
                        disabled={pending || index === shown.length - 1}
                        aria-label={t("apps_menu_move_down", { app: app.name })}
                        title={t("apps_menu_move_down", { app: app.name })}
                        onClick={() => moveBy(index, 1)}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        className={styles.iconButton}
                        disabled={pending}
                        aria-label={t("apps_menu_remove", { app: app.name })}
                        title={t("apps_menu_remove", { app: app.name })}
                        onClick={() => removeFromMenu(app.id)}
                      >
                        <Minus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.list}>
              <div className={styles.listHeader}>
                {t("apps_menu_more_heading")}
              </div>
              <div className={styles.listBody}>
                {more.length === 0 && (
                  <div className={styles.listEmpty}>
                    {t("apps_menu_more_empty")}
                  </div>
                )}
                {more.map((app) => (
                  <div className={styles.appRow} key={app.id}>
                    <AppIcon app={app} />
                    <span className={styles.appRowName}>{app.name}</span>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        disabled={pending}
                        aria-label={t("apps_menu_add", { app: app.name })}
                        title={t("apps_menu_add", { app: app.name })}
                        onClick={() => addToMenu(app.id)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {showResetRow && (
          <div className={styles.resetRow}>
            <button
              type="button"
              className={styles.resetButton}
              disabled={pending || !customized}
              onClick={resetToDefault}
            >
              {t("apps_menu_reset")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
