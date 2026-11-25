import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";

export function SlashCommandTop() {
  const { t } = useTranslation();
  const commands = useAppStore((s) => s.analyticsMetrics?.topSlashCommands);
  const max = commands?.reduce((m, [, n]) => (n > m ? n : m), 0) ?? 0;

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>{t("metrics_top_slash")}</span>
      {!commands || commands.length === 0 ? (
        <div className={styles.empty}>{t("metrics_no_data")}</div>
      ) : (
        <div className={styles.rowList}>
          {commands.map(([name, count]) => {
            const pct = max === 0 ? 0 : (count / max) * 100;
            return (
              <div key={name} className={styles.slashRow}>
                <span className={styles.rowLabel}>/{name}</span>
                <div
                  className={`${styles.progressTrack} ${styles.progressTrackThin}`}
                >
                  <div
                    className={styles.progressFill}
                    style={{ "--p": `${pct}%` } as CSSProperties}
                  />
                </div>
                <span className={styles.rowValue}>{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
