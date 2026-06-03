import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import styles from "./ShellEnvCard.module.css";

const parseDraft = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function ShellEnvCard() {
  const { t } = useTranslation("settings");
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

  // `?? "—"` only catches undefined; an empty array would render "()".
  // Use a length check so the no-source case shows the placeholder.
  const sources = shellEnv?.source_files.length
    ? shellEnv.source_files.join(", ")
    : "—";

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
        <h3>{t("shell_env_title")}</h3>
        <button
          type="button"
          onClick={() => {
            void reloadShellEnv();
          }}
          className={styles.iconButton}
        >
          ↻ {t("shell_env_reload")}
        </button>
      </header>
      <p className={styles.cardSubtitle}>
        {t("shell_env_captured_from", {
          sources,
          lastRefreshed,
        })}
      </p>
      {shellEnv?.error ? (
        <p className={styles.errorText} role="alert">
          {shellEnv.error}
        </p>
      ) : null}
      <h4>
        {t("shell_env_forwarded_heading", {
          count: shellEnv?.forwarded.length ?? 0,
        })}
      </h4>
      <p className={styles.cardSubtitle}>{t("shell_env_forwarded_desc")}</p>
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
              {revealed[v.name] ? t("shell_env_hide") : t("shell_env_show")}
            </button>
          </li>
        ))}
      </ul>
      {shellEnv?.inherited && shellEnv.inherited.length > 0 ? (
        <>
          <h4>
            {t("shell_env_inherited_heading", {
              count: shellEnv.inherited.length,
            })}
          </h4>
          <p className={styles.cardSubtitle}>
            {t("shell_env_inherited_desc")}
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
                  {revealed[`inh:${v.name}`]
                    ? t("shell_env_hide")
                    : t("shell_env_show")}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {shellEnv?.denied_built_in && shellEnv.denied_built_in.length > 0 ? (
        <details>
          <summary>
            {t("shell_env_built_in_denied", {
              count: shellEnv.denied_built_in.length,
            })}
          </summary>
          <code className={styles.deniedList}>
            {shellEnv.denied_built_in.join(", ")}
          </code>
        </details>
      ) : null}
      <label className={styles.denyLabel}>{t("shell_env_deny_label")}</label>
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
            ? t("shell_env_enable")
            : t("shell_env_disable")}
        </button>
      </div>
    </section>
  );
}
