import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Timeline } from "../primitives/Timeline";

export function SessionTimeline() {
  const dots = useAppStore((s) => s.analyticsMetrics?.recentSessions24h ?? []);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  return (
    <div className={`${styles.panel} ${styles.panelFull}`}>
      <span className={styles.panelTitle}>Sessions · last 24h</span>
      <Timeline dots={dots} onSelect={selectWorkspace} />
    </div>
  );
}
