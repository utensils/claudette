import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  deleteScheduledRoutine,
  listScheduledRoutines,
  runScheduledRoutine,
  type ScheduledTask,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

function formatFireTime(value: string | null, t: TFunction<"settings">): string {
  if (!value) return t("automation_not_scheduled");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function routineLabel(task: ScheduledTask): string {
  return task.name || task.id;
}

function formatDisabledReason(reason: string | null, t: TFunction<"settings">): string | null {
  switch (reason) {
    case "workspace_archived":
      return t("automation_disabled_reason_workspace_archived");
    case "workspace_unavailable":
      return t("automation_disabled_reason_workspace_unavailable");
    case "terminal_dispatch_error":
      return t("automation_disabled_reason_terminal_dispatch_error");
    case null:
      return null;
    default:
      return reason.replaceAll("_", " ");
  }
}

function routineDescription(task: ScheduledTask, t: TFunction<"settings">): string {
  const status = task.enabled
    ? t("automation_status_enabled")
    : t("automation_status_disabled");
  const nextFire = `${t("automation_next_fire")}: ${formatFireTime(task.next_fire_at, t)}`;
  const disabledReason = formatDisabledReason(task.disabled_reason, t);
  const disabledDetail =
    !task.enabled && disabledReason
      ? ` ${t("automation_disabled_reason")}: ${disabledReason}.`
      : "";
  const lastError =
    task.last_error ? ` ${t("automation_last_error")}: ${task.last_error}.` : "";
  if (task.kind === "wakeup") {
    return `${t("automation_kind_wakeup")}, ${status}. ${nextFire}.${disabledDetail}${lastError}`;
  }
  const schedule =
    task.human_schedule || task.cron_expr || t("automation_unknown_schedule");
  const mode = task.recurring
    ? t("automation_mode_recurring")
    : t("automation_mode_one_shot");
  return `${schedule}, ${mode}, ${status}. ${nextFire}.${disabledDetail}${lastError}`;
}

export function AutomationSettings() {
  const { t } = useTranslation("settings");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await listScheduledRoutines());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) =>
        (a.next_fire_at || "zzzz").localeCompare(b.next_fire_at || "zzzz"),
      ),
    [tasks],
  );

  const runNow = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await runScheduledRoutine(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const deleteTask = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteScheduledRoutine(id);
      setTasks((current) => current.filter((task) => task.id !== id));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{t("automation_title")}</h2>
        <button className={styles.iconBtn} onClick={refresh} disabled={loading}>
          <RefreshCw size={14} />
          {t("automation_refresh")}
        </button>
      </div>
      <p className={styles.sectionDescription}>
        {t("automation_description")}
      </p>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.fieldHint}>{t("automation_loading")}</div>
      ) : sorted.length === 0 ? (
        <div className={styles.fieldHint}>{t("automation_empty")}</div>
      ) : (
        sorted.map((task) => (
          <div key={task.id} className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <div className={styles.settingLabel}>{routineLabel(task)}</div>
              <div className={styles.settingDescription}>
                {routineDescription(task, t)}
              </div>
              <div className={styles.settingDescription}>{task.prompt}</div>
            </div>
            <div className={styles.settingControl}>
              <div className={styles.buttonRow}>
                <button
                  className={styles.iconBtn}
                  title={t("automation_run")}
                  aria-label={t("automation_run")}
                  onClick={() => runNow(task.id)}
                  disabled={busyId === task.id}
                >
                  <Play size={14} />
                </button>
                <button
                  className={styles.iconBtn}
                  title={t("automation_delete")}
                  aria-label={t("automation_delete")}
                  onClick={() => deleteTask(task.id)}
                  disabled={busyId === task.id}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
