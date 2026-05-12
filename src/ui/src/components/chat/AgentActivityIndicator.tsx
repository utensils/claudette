import styles from "./AgentActivityIndicator.module.css";

export function AgentActivityIndicator() {
  return (
    <span className={styles.indicator} aria-hidden="true">
      <span className={styles.bar} />
      <span className={styles.bar} />
      <span className={styles.bar} />
    </span>
  );
}
