import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";

export function SlashCommandTop() {
  const commands = useAppStore(
    (s) => s.analyticsMetrics?.topSlashCommands ?? []
  );
  const max = commands.reduce((m, [, n]) => (n > m ? n : m), 0);

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>Top slash commands</span>
      {commands.length === 0 ? (
        <div className={styles.empty}>no data yet</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {commands.map(([name, count]) => {
            const pct = max === 0 ? 0 : (count / max) * 100;
            return (
              <div key={name} className={styles.slashRow}>
                <span className={styles.rowLabel}>/{name}</span>
                <div
                  style={{
                    position: "relative",
                    height: 8,
                    background: "var(--divider)",
                    borderRadius: 2,
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: "var(--accent-primary)",
                      borderRadius: 2,
                      opacity: 0.85,
                      transition: "width 400ms ease-out",
                    }}
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
