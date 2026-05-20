import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveSessionId } from "../../stores/useAppStore";
import { createCronRoutine, scheduleWakeup } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./CreateScheduledTaskModal.module.css";

type TaskType = "wakeup" | "cron";

/** `Date` -> value for `<input type="datetime-local">` (local time, no tz). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Very-loose 5-field cron validator. The backend has the authoritative
 *  parser; this just catches obvious typos before the round trip. */
function looksLikeCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  return fields.length === 5;
}

export function CreateScheduledTaskModal() {
  const { t } = useTranslation("scheduler");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const loadScheduledTasks = useAppStore((s) => s.loadScheduledTasks);
  const activeSessionId = useAppStore(selectActiveSessionId);

  /** Flat list of selectable sessions, with a label that disambiguates
   *  across workspaces. */
  const sessions = useMemo(() => {
    const rows: { id: string; label: string }[] = [];
    for (const [wsId, list] of Object.entries(sessionsByWorkspace)) {
      const ws = workspaces.find((w) => w.id === wsId);
      const wsLabel = ws?.branch_name ?? wsId.slice(0, 8);
      for (const s of list) {
        if (s.status === "Archived") continue;
        rows.push({ id: s.id, label: `${wsLabel} · ${s.name}` });
      }
    }
    return rows;
  }, [sessionsByWorkspace, workspaces]);

  const prefillSessionId =
    typeof modalData.sessionId === "string" ? (modalData.sessionId as string) : null;
  const prefillPrompt =
    typeof modalData.prompt === "string" ? (modalData.prompt as string) : "";
  const prefillFireAt =
    typeof modalData.fireAt === "string" ? (modalData.fireAt as string) : null;
  const prefillCron =
    typeof modalData.cronExpr === "string" ? (modalData.cronExpr as string) : "";

  const [type, setType] = useState<TaskType>(() =>
    prefillCron ? "cron" : "wakeup",
  );
  const [sessionId, setSessionId] = useState<string>(
    () => prefillSessionId ?? activeSessionId ?? sessions[0]?.id ?? "",
  );
  const [fireAt, setFireAt] = useState<string>(() => {
    if (prefillFireAt) {
      const d = new Date(prefillFireAt);
      if (!Number.isNaN(d.getTime())) return toDatetimeLocalValue(d);
    }
    return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
  });
  const [cronExpr, setCronExpr] = useState<string>(prefillCron);
  const [name, setName] = useState<string>("");
  const [recurring, setRecurring] = useState<boolean>(true);
  const [prompt, setPrompt] = useState<string>(prefillPrompt);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the picker has no value yet but sessions arrive, default to the active
  // one (or the first available).
  useEffect(() => {
    if (!sessionId && sessions.length > 0) {
      setSessionId(activeSessionId ?? sessions[0].id);
    }
  }, [sessionId, sessions, activeSessionId]);

  const handleSubmit = async () => {
    setError(null);
    if (!sessionId) {
      setError(t("error_pick_session"));
      return;
    }
    if (!prompt.trim()) {
      setError(t("error_empty_prompt"));
      return;
    }
    try {
      setSubmitting(true);
      if (type === "wakeup") {
        const when = new Date(fireAt);
        if (Number.isNaN(when.getTime())) {
          setError(t("error_bad_time"));
          setSubmitting(false);
          return;
        }
        await scheduleWakeup({
          sessionId,
          fireAt: when.toISOString(),
          prompt: prompt.trim(),
        });
      } else {
        if (!looksLikeCron(cronExpr)) {
          setError(t("error_bad_cron"));
          setSubmitting(false);
          return;
        }
        await createCronRoutine({
          sessionId,
          name: name.trim() || undefined,
          cronExpr: cronExpr.trim(),
          prompt: prompt.trim(),
          recurring,
        });
      }
      void loadScheduledTasks();
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={t("modal_title")} onClose={closeModal} wide>
      <div className={shared.field}>
        <label className={shared.label}>{t("type_label")}</label>
        <div className={styles.typeRow}>
          <label className={styles.typeOption}>
            <input
              type="radio"
              name="task-type"
              value="wakeup"
              checked={type === "wakeup"}
              onChange={() => setType("wakeup")}
            />
            <span>{t("type_wakeup")}</span>
          </label>
          <label className={styles.typeOption}>
            <input
              type="radio"
              name="task-type"
              value="cron"
              checked={type === "cron"}
              onChange={() => setType("cron")}
            />
            <span>{t("type_cron")}</span>
          </label>
        </div>
      </div>

      <div className={shared.field}>
        <label className={shared.label}>{t("session_label")}</label>
        <select
          className={shared.input}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          disabled={sessions.length === 0}
        >
          {sessions.length === 0 && (
            <option value="">{t("session_none_available")}</option>
          )}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === activeSessionId ? `${t("session_current")} — ${s.label}` : s.label}
            </option>
          ))}
        </select>
      </div>

      {type === "wakeup" ? (
        <div className={shared.field}>
          <label className={shared.label}>{t("fire_at_label")}</label>
          <input
            className={shared.input}
            type="datetime-local"
            value={fireAt}
            onChange={(e) => setFireAt(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className={shared.field}>
            <label className={shared.label}>{t("cron_expr_label")}</label>
            <input
              className={shared.input}
              type="text"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 9 * * 1-5"
            />
            <div className={shared.smallHint}>{t("cron_expr_hint")}</div>
          </div>
          <div className={shared.field}>
            <label className={shared.label}>{t("name_label")}</label>
            <input
              className={shared.input}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className={shared.checkboxRow}>
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            <span>{t("recurring_label")}</span>
          </label>
        </>
      )}

      <div className={shared.field}>
        <label className={shared.label}>{t("prompt_label")}</label>
        <textarea
          className={shared.input}
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("prompt_placeholder")}
        />
      </div>

      {error && <div className={shared.error}>{error}</div>}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={submitting || !sessionId}
        >
          {submitting ? t("creating") : t("create_btn")}
        </button>
      </div>
    </Modal>
  );
}
