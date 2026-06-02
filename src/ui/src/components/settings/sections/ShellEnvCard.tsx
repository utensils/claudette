import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import styles from "./ShellEnvCard.module.css";

const parseDraft = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function ShellEnvCard() {
  const shellEnv = useAppStore((s) => s.shellEnv);
  const refreshShellEnv = useAppStore((s) => s.refreshShellEnv);
  const reloadShellEnv = useAppStore((s) => s.reloadShellEnv);
  const setShellEnvDenylist = useAppStore((s) => s.setShellEnvDenylist);
  const setShellEnvDisabled = useAppStore((s) => s.setShellEnvDisabled);

  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [denyDraft, setDenyDraft] = useState<string>("");
  const textareaFocused = useRef(false);

  useEffect(() => {
    void refreshShellEnv();
  }, [refreshShellEnv]);

  // Hydrate the deny draft from the persisted snapshot whenever it changes,
  // but only when the textarea is not focused (to avoid clobbering in-progress
  // edits). Focus-gating handles the empty->repopulate case too: a no-op
  // focus/blur never persists (see the blur guard below), so a saved denylist
  // can't be silently cleared.
  useEffect(() => {
    if (textareaFocused.current) return;
    const persisted = shellEnv?.denied_user ?? [];
    setDenyDraft(persisted.join("\n"));
  }, [shellEnv?.denied_user]);

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
      <p className={styles.cardSubtitle}>
        Vars that shell-init adds on top of the launch baseline. The shell-env
        tier applies these to every subprocess Claudette spawns.
      </p>
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
      {shellEnv?.inherited && shellEnv.inherited.length > 0 ? (
        <>
          <h4>{shellEnv.inherited.length} variables inherited from parent process</h4>
          <p className={styles.cardSubtitle}>
            These vars are already in Claudette&apos;s process environment
            (inherited from the parent shell at launch). Subprocesses get them
            via normal env inheritance — the shell-env tier doesn&apos;t need to
            re-add them.
          </p>
          <ul className={styles.varList}>
            {shellEnv.inherited.map((v) => (
              <li key={v.name} className={styles.varRow}>
                <span className={styles.varName}>{v.name}</span>
                <span className={styles.varValue}>
                  {revealed[`inh:${v.name}`] ? v.value : "●●●●●●●●●●"}
                </span>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() =>
                    setRevealed((r) => ({
                      ...r,
                      [`inh:${v.name}`]: !r[`inh:${v.name}`],
                    }))
                  }
                >
                  {revealed[`inh:${v.name}`] ? "hide" : "show"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
        onFocus={() => {
          textareaFocused.current = true;
        }}
        onBlur={() => {
          textareaFocused.current = false;
          const next = parseDraft(denyDraft);
          const current = shellEnv?.denied_user ?? [];
          const same =
            next.length === current.length &&
            next.every((v, i) => v === current[i]);
          if (!same) {
            void setShellEnvDenylist(next);
          }
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
