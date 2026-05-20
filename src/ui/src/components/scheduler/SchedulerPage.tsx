import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Trash2, RefreshCw, Plus, Repeat, CalendarClock } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { PanelHeader } from "../shared/PanelHeader";
import { PanelToggles } from "../shared/PanelToggles";
import { BoundedScrollPane } from "../shared/BoundedScrollPane";
import {
  type ScheduledTask,
  deleteScheduledRoutine,
  runScheduledRoutine,
} from "../../services/tauri";
import styles from "./SchedulerPage.module.css";

function formatLocalDateTime(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatCountdown(iso: string | null, now: number): string {
  if (!iso) return "—";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return iso;
  let delta = Math.round((target - now) / 1000);
  if (delta <= 0) return "due now";
  const d = Math.floor(delta / 86400);
  delta -= d * 86400;
  const h = Math.floor(delta / 3600);
  delta -= h * 3600;
  const m = Math.floor(delta / 60);
  const s = delta - m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (s || parts.length === 0)) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ");
}

export function SchedulerPage() {
  const { t } = useTranslation("scheduler");
  const scheduledTasks = useAppStore((s) => s.scheduledTasks);
  const loadScheduledTasks = useAppStore((s) => s.loadScheduledTasks);
  const setScheduledTasks = useAppStore((s) => s.setScheduledTasks);
  const openModal = useAppStore((s) => s.openModal);
  const workspaces = useAppStore((s) => s.workspaces);

  // 1s ticker for the countdown labels.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadScheduledTasks();
  }, [loadScheduledTasks]);

  const { loops, schedules } = useMemo(() => {
    const sorted = [...scheduledTasks].sort((a, b) =>
      (a.next_fire_at || "zzzz").localeCompare(b.next_fire_at || "zzzz"),
    );
    return {
      loops: sorted.filter((t) => t.kind === "cron"),
      schedules: sorted.filter((t) => t.kind === "wakeup"),
    };
  }, [scheduledTasks]);

  const workspaceLabel = (id: string): string => {
    const ws = workspaces.find((w) => w.id === id);
    return ws ? ws.branch_name : id.slice(0, 8);
  };

  const runNow = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await runScheduledRoutine(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteScheduledRoutine(id);
      setScheduledTasks(scheduledTasks.filter((task) => task.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onRefresh = () => {
    void loadScheduledTasks();
  };

  return (
    <div className={styles.page}>
      <PanelHeader
        left={<span className={styles.title}>{t("title")}</span>}
        right={<PanelToggles />}
      />
      <BoundedScrollPane className={styles.body}>
        <div className={styles.topBar}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => openModal("createScheduledTask")}
          >
            <Plus size={13} />
            {t("new_btn")}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={onRefresh}
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <RefreshCw size={13} />
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {/* Loops (cron routines) */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <Repeat size={12} />
            <span>{t("loops_heading")}</span>
            <span className={styles.count}>{loops.length}</span>
          </div>
          {loops.length === 0 ? (
            <p className={styles.empty}>{t("loops_empty")}</p>
          ) : (
            <ul className={styles.list}>
              {loops.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  workspaceLabel={workspaceLabel}
                  busyId={busyId}
                  onRun={runNow}
                  onDelete={onDelete}
                  t={t}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Schedules (wakeups) */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <CalendarClock size={12} />
            <span>{t("schedules_heading")}</span>
            <span className={styles.count}>{schedules.length}</span>
          </div>
          {schedules.length === 0 ? (
            <p className={styles.empty}>{t("schedules_empty")}</p>
          ) : (
            <ul className={styles.list}>
              {schedules.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  workspaceLabel={workspaceLabel}
                  busyId={busyId}
                  onRun={runNow}
                  onDelete={onDelete}
                  t={t}
                />
              ))}
            </ul>
          )}
        </section>
      </BoundedScrollPane>
    </div>
  );
}

interface TaskRowProps {
  task: ScheduledTask;
  now: number;
  workspaceLabel: (id: string) => string;
  busyId: string | null;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  t: ReturnType<typeof useTranslation<"scheduler">>["t"];
}

function TaskRow({ task, now, workspaceLabel, busyId, onRun, onDelete, t }: TaskRowProps) {
  const isWakeup = task.kind === "wakeup";
  const schedule = isWakeup
    ? formatLocalDateTime(task.fire_at) ?? t("fire_at_unknown")
    : task.human_schedule || task.cron_expr || t("schedule_unknown");
  const next = task.next_fire_at
    ? `${t("next_in", { time: formatCountdown(task.next_fire_at, now) })}`
    : t("not_scheduled");
  const last = task.last_fired_at
    ? `· ${t("last_fired", { time: formatLocalDateTime(task.last_fired_at) ?? "" })}`
    : "";
  const mode = !isWakeup
    ? task.recurring
      ? t("mode_recurring")
      : t("mode_one_shot")
    : null;
  const isBusy = busyId === task.id;

  return (
    <li className={`${styles.row} ${task.enabled ? "" : styles.rowMuted}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>{task.name || task.prompt}</div>
        <div className={styles.rowMeta}>
          {schedule}
          {mode ? ` · ${mode}` : ""} · {next} {last} · {workspaceLabel(task.workspace_id)}
        </div>
        {task.name && <div className={styles.rowPrompt}>{task.prompt}</div>}
        {task.reason && <div className={styles.rowReason}>{task.reason}</div>}
      </div>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.btn}
          onClick={() => onRun(task.id)}
          disabled={isBusy}
          title={t("run_now")}
          aria-label={t("run_now")}
        >
          <Play size={13} />
        </button>
        <button
          type="button"
          className={styles.btnDanger}
          onClick={() => onDelete(task.id)}
          disabled={isBusy}
          title={t("delete")}
          aria-label={t("delete")}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}
