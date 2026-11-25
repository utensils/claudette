import { useTranslation } from "react-i18next";
import { SafeTrans } from "../shared/SafeTrans";
import { useAppStore } from "../../stores/useAppStore";
import {
  installNow,
  installWhenIdle,
  dismiss,
  retryInstall,
} from "../../hooks/useAutoUpdater";
import { openUrl } from "../../services/tauri";
import styles from "./UpdateBanner.module.css";

const RELEASE_URL_BY_CHANNEL = {
  stable: "https://github.com/utensils/claudette/releases/latest",
  nightly: "https://github.com/utensils/claudette/releases/tag/nightly",
} as const;

export function UpdateBanner() {
  const { t } = useTranslation();
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateDismissed = useAppStore((s) => s.updateDismissed);
  const updateInstallWhenIdle = useAppStore((s) => s.updateInstallWhenIdle);
  const updateDownloading = useAppStore((s) => s.updateDownloading);
  const updateProgress = useAppStore((s) => s.updateProgress);
  const updateChannel = useAppStore((s) => s.updateChannel);
  const updateError = useAppStore((s) => s.updateError);
  const setUpdateError = useAppStore((s) => s.setUpdateError);

  if (updateError) {
    const releaseUrl = RELEASE_URL_BY_CHANNEL[updateChannel];
    const dismissError = () => {
      setUpdateError(null);
      dismiss();
    };
    return (
      <div className={styles.banner} role="alert">
        <span className={`${styles.message} ${styles.errorMessage}`}>
          {t("update_failed", { error: updateError })}
        </span>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={retryInstall}>
            {t("update_try_again")}
          </button>
          <button
            className={styles.btn}
            onClick={() => {
              void openUrl(releaseUrl).catch(() => {});
            }}
          >
            {t("update_view_release")}
          </button>
          <button className={styles.btn} onClick={dismissError}>
            {t("update_dismiss")}
          </button>
        </div>
      </div>
    );
  }

  if (!updateAvailable || updateDismissed) return null;

  const productLabel =
    updateChannel === "nightly" ? "Claudette Nightly" : "Claudette";

  return (
    <div className={styles.banner}>
      {updateDownloading ? (
        <>
          <span className={styles.message}>{t("update_downloading")}</span>
          <div className={styles.progressWrap}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBar}
                style={{ width: `${updateProgress}%` }}
              />
            </div>
            <span className={styles.progressLabel}>{updateProgress}%</span>
          </div>
        </>
      ) : updateInstallWhenIdle ? (
        <>
          <span className={styles.message}>
            <SafeTrans
              i18nKey="update_ready"
              values={{ version: updateVersion }}
              components={{ version: <span className={styles.version} /> }}
            />
          </span>
          <span className={styles.idleMessage}>
            {t("update_install_when_idle")}
          </span>
          <div className={styles.actions}>
            <button className={styles.btnPrimary} onClick={installNow}>
              {t("update_install_now")}
            </button>
          </div>
        </>
      ) : (
        <>
          <span className={styles.message}>
            <SafeTrans
              i18nKey="update_available"
              values={{ product: productLabel, version: updateVersion }}
              components={{ version: <span className={styles.version} /> }}
            />
          </span>
          <div className={styles.actions}>
            <button className={styles.btnPrimary} onClick={installNow}>
              {t("update_install_now")}
            </button>
            <button className={styles.btn} onClick={installWhenIdle}>
              {t("update_when_idle")}
            </button>
            <button className={styles.btn} onClick={dismiss}>
              {t("update_dismiss")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
