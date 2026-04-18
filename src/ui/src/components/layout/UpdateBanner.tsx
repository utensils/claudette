import { useAppStore } from "../../stores/useAppStore";
import { installNow, installWhenIdle, dismiss } from "../../hooks/useAutoUpdater";
import styles from "./UpdateBanner.module.css";

export function UpdateBanner() {
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateDismissed = useAppStore((s) => s.updateDismissed);
  const updateInstallWhenIdle = useAppStore((s) => s.updateInstallWhenIdle);
  const updateDownloading = useAppStore((s) => s.updateDownloading);
  const updateProgress = useAppStore((s) => s.updateProgress);

  if (!updateAvailable || updateDismissed) return null;

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
            Claudette <span className={styles.version}>v{updateVersion}</span>{" "}
            is available
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
