import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import styles from "./ShellEnvCard.module.css";

export function ShellEnvCard() {
  const shellEnv = useAppStore((s) => s.shellEnv);
  const refreshShellEnv = useAppStore((s) => s.refreshShellEnv);
  const reloadShellEnv = useAppStore((s) => s.reloadShellEnv);
  const setShellEnvDenylist = useAppStore((s) => s.setShellEnvDenylist);
  const setShellEnvDisabled = useAppStore((s) => s.setShellEnvDisabled);

  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [denyDraft, setDenyDraft] = useState<string>("");

  useEffect(() => {
    void refreshShellEnv();
  }, [refreshShellEnv]);

  const sources = shellEnv?.source_files.join(", ") ?? "—";

  const lastRefreshed = useMemo(() => {
    if (!shellEnv?.captured_at_ms) return "—";
    const seconds = Math.round((Date.now() - shellEnv.captured_at_ms) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  }, [shellEnv?.captured_at_ms]);

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h3>Shell environment</h3>
        <button
          type="button"
          onClick={() => {
            void reloadShellEnv();
          }}
          className={styles.iconButton}
        >
          ↻ Reload
        </button>
      </header>
      <p className={styles.cardSubtitle}>
        Captured from your shell init ({sources}) · last refreshed{" "}
        {lastRefreshed}
      </p>
      {shellEnv?.error ? (
        <p className={styles.errorText} role="alert">
          {shellEnv.error}
        </p>
      ) : null}
      <h4>{shellEnv?.forwarded.length ?? 0} variables forwarded</h4>
      <ul className={styles.varList}>
        {shellEnv?.forwarded.map((v) => (
          <li key={v.name} className={styles.varRow}>
            <span className={styles.varName}>{v.name}</span>
            <span className={styles.varValue}>
              {revealed[v.name] ? v.value : "●●●●●●●●●●"}
            </span>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() =>
                setRevealed((r) => ({ ...r, [v.name]: !r[v.name] }))
              }
            >
              {revealed[v.name] ? "hide" : "show"}
            </button>
          </li>
        ))}
      </ul>
      {shellEnv?.denied_built_in && shellEnv.denied_built_in.length > 0 ? (
        <details>
          <summary>{shellEnv.denied_built_in.length} built-in denied</summary>
          <code className={styles.deniedList}>
            {shellEnv.denied_built_in.join(", ")}
          </code>
        </details>
      ) : null}
      <label className={styles.denyLabel}>
        Additional deny patterns (one glob per line):
      </label>
      <textarea
        value={denyDraft}
        onChange={(e) => setDenyDraft(e.target.value)}
        onBlur={() => {
          void setShellEnvDenylist(
            denyDraft
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          );
        }}
        rows={4}
        className={styles.denyTextarea}
        placeholder={"AWS_*\nSTRIPE_*"}
      />
      <div className={styles.cardFooter}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            void setShellEnvDisabled(!(shellEnv?.disabled ?? false));
          }}
        >
          {shellEnv?.disabled
            ? "Enable shell-env"
            : "Disable shell-env entirely"}
        </button>
      </div>
    </section>
  );
}
