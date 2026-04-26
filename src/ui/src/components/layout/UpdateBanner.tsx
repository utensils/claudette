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
          Update failed: {updateError}
        </span>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={retryInstall}>
            Try again
          </button>
          <button
            className={styles.btn}
            onClick={() => {
              void openUrl(releaseUrl).catch(() => {});
            }}
          >
            View release page
          </button>
          <button className={styles.btn} onClick={dismissError}>
            Dismiss
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
          <span className={styles.message}>Downloading update...</span>
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
            <span className={styles.version}>v{updateVersion}</span> ready
          </span>
          <span className={styles.idleMessage}>
            Will install when all agents finish
          </span>
          <div className={styles.actions}>
            <button className={styles.btnPrimary} onClick={installNow}>
              Install Now
            </button>
          </div>
        </>
      ) : (
        <>
          <span className={styles.message}>
            {productLabel}{" "}
            <span className={styles.version}>v{updateVersion}</span> is
            available
          </span>
          <div className={styles.actions}>
            <button className={styles.btnPrimary} onClick={installNow}>
              Install Now
            </button>
            <button className={styles.btn} onClick={installWhenIdle}>
              When Idle
            </button>
            <button className={styles.btn} onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
