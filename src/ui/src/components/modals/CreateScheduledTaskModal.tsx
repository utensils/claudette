import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveSessionId } from "../../stores/useAppStore";
import {
  createCronRoutine,
  listChatSessions,
  scheduleWakeup,
} from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./CreateScheduledTaskModal.module.css";

type TaskType = "wakeup" | "cron";

/** Sentinel for the session dropdown's "create a fresh session each run"
 *  choice. Distinct from any real session id. */
const NEW_SESSION = "__new_session__";

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
  return trimmed.split(/\s+/).length === 5;
}

export function CreateScheduledTaskModal() {
  const { t } = useTranslation("scheduler");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const sessionsLoadedByWorkspace = useAppStore((s) => s.sessionsLoadedByWorkspace);
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const loadScheduledTasks = useAppStore((s) => s.loadScheduledTasks);
  const activeSessionId = useAppStore(selectActiveSessionId);

  const prefillSessionId =
    typeof modalData.sessionId === "string" ? (modalData.sessionId as string) : null;
  const prefillPrompt =
    typeof modalData.prompt === "string" ? (modalData.prompt as string) : "";
  const prefillFireAt =
    typeof modalData.fireAt === "string" ? (modalData.fireAt as string) : null;
  const prefillCron =
    typeof modalData.cronExpr === "string" ? (modalData.cronExpr as string) : "";

  // Active (non-archived) workspaces for a repo, in sidebar order.
  const workspacesForRepo = (repoId: string) =>
    workspaces
      .filter((w) => w.repository_id === repoId && w.status !== "Archived")
      .sort((a, b) => a.sort_order - b.sort_order);

  // Resolve the initial repo/workspace once, at mount, from the prefilled
  // session (a `/schedule` from a chat), then the currently open workspace,
  // then the first available workspace.
  const [repoId, setRepoId] = useState<string>(() => {
    const s = useAppStore.getState();
    const seedWsId =
      (prefillSessionId &&
        Object.entries(s.sessionsByWorkspace).find(([, list]) =>
          list.some((cs) => cs.id === prefillSessionId),
        )?.[0]) ||
      s.selectedWorkspaceId ||
      s.workspaces.find((w) => w.status !== "Archived")?.id ||
      "";
    return s.workspaces.find((w) => w.id === seedWsId)?.repository_id ?? s.repositories[0]?.id ?? "";
  });
  const [workspaceId, setWorkspaceId] = useState<string>(() => {
    const s = useAppStore.getState();
    if (prefillSessionId) {
      const hit = Object.entries(s.sessionsByWorkspace).find(([, list]) =>
        list.some((cs) => cs.id === prefillSessionId),
      );
      if (hit) return hit[0];
    }
    return (
      s.selectedWorkspaceId ||
      s.workspaces.find((w) => w.status !== "Archived")?.id ||
      ""
    );
  });
  const [sessionTarget, setSessionTarget] = useState<string>(
    () => prefillSessionId ?? activeSessionId ?? NEW_SESSION,
  );

  const [type, setType] = useState<TaskType>(() => (prefillCron ? "cron" : "wakeup"));
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
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load the chosen workspace's sessions. SessionTabs only loads the
  // open workspace, so unopened ones are blank until we fetch them here.
  useEffect(() => {
    if (!workspaceId || sessionsLoadedByWorkspace[workspaceId]) return;
    let cancelled = false;
    setLoadingSessions(true);
    listChatSessions(workspaceId)
      .then((list) => {
        if (!cancelled) setSessionsForWorkspace(workspaceId, list);
      })
      .catch(() => {
        // Leave the dropdown with just "New session"; submit still works.
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionsLoadedByWorkspace, setSessionsForWorkspace]);

  // Keep the workspace consistent with the selected repo.
  useEffect(() => {
    const list = workspacesForRepo(repoId);
    if (workspaceId && list.some((w) => w.id === workspaceId)) return;
    setWorkspaceId(list[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  const workspaceSessions = useMemo(
    () =>
      (sessionsByWorkspace[workspaceId] ?? []).filter((s) => s.status !== "Archived"),
    [sessionsByWorkspace, workspaceId],
  );

  // Once the workspace's sessions are known, drop a stale session target
  // (one belonging to a different workspace) down to the first session, or
  // to "new session" if the workspace has none. Never clobbers an explicit
  // "new session" choice.
  useEffect(() => {
    if (!workspaceId || !sessionsLoadedByWorkspace[workspaceId]) return;
    setSessionTarget((prev) => {
      if (prev === NEW_SESSION) return prev;
      if (workspaceSessions.some((s) => s.id === prev)) return prev;
      return workspaceSessions[0]?.id ?? NEW_SESSION;
    });
  }, [workspaceId, workspaceSessions, sessionsLoadedByWorkspace]);

  const repoWorkspaces = workspacesForRepo(repoId);
  const usesNewSession = sessionTarget === NEW_SESSION;
  const canSubmit = !submitting && !!workspaceId && (usesNewSession || !!sessionTarget);

  const handleSubmit = async () => {
    setError(null);
    if (!workspaceId) {
      setError(t("error_pick_workspace"));
      return;
    }
    if (!usesNewSession && !sessionTarget) {
      setError(t("error_pick_session"));
      return;
    }
    if (!prompt.trim()) {
      setError(t("error_empty_prompt"));
      return;
    }
    const targetArgs = usesNewSession
      ? { workspaceId, createNewSession: true }
      : { sessionId: sessionTarget };
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
          ...targetArgs,
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
          ...targetArgs,
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

      <div className={styles.targetRow}>
        <div className={shared.field}>
          <label className={shared.label}>{t("target_repo")}</label>
          <select
            className={shared.input}
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            disabled={repositories.length === 0}
          >
            {repositories.length === 0 && (
              <option value="">{t("no_repos")}</option>
            )}
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className={shared.field}>
          <label className={shared.label}>{t("target_workspace")}</label>
          <select
            className={shared.input}
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={repoWorkspaces.length === 0}
          >
            {repoWorkspaces.length === 0 && (
              <option value="">{t("no_workspaces")}</option>
            )}
            {repoWorkspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={shared.field}>
        <label className={shared.label}>{t("target_session")}</label>
        <select
          className={shared.input}
          value={sessionTarget}
          onChange={(e) => setSessionTarget(e.target.value)}
          disabled={!workspaceId}
        >
          <option value={NEW_SESSION}>{t("new_session_option")}</option>
          {workspaceSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === activeSessionId ? `${s.name} (${t("session_current")})` : s.name}
            </option>
          ))}
        </select>
        <div className={shared.smallHint}>
          {loadingSessions
            ? t("loading_sessions")
            : usesNewSession
              ? t("new_session_hint")
              : t("reuse_session_hint")}
        </div>
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
        <button className={shared.btnPrimary} onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? t("creating") : t("create_btn")}
        </button>
      </div>
    </Modal>
  );
}
