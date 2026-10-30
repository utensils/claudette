import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshCw,
  Plus,
  Repeat,
  CalendarClock,
  Activity,
  AlertTriangle,
  Timer,
  Search,
  Eraser,
  History,
} from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { PanelHeader } from "../shared/PanelHeader";
import { PanelToggles } from "../shared/PanelToggles";
import { BoundedScrollPane } from "../shared/BoundedScrollPane";
import type { ChatSession } from "../../types/chat";
import {
  type ScheduledTask,
  deleteScheduledRoutine,
  getChatSession,
  listChatSessions,
  pauseScheduledRoutine,
  resumeScheduledRoutine,
  runScheduledRoutine,
} from "../../services/tauri";
import {
  type StatusFilter,
  type TaskStatus,
  formatCountdown,
  liveSessionId,
  matchesFilter,
  summarize,
  taskStatus,
} from "./schedulerModel";
import { RunItem, SchedulerTaskRow } from "./SchedulerTaskRow";
import styles from "./SchedulerPage.module.css";

const STATUS_FILTERS: StatusFilter[] = ["all", "active", "paused", "attention"];

export function SchedulerPage() {
  const { t } = useTranslation("scheduler");
  const scheduledTasks = useAppStore((s) => s.scheduledTasks);
  const recentRuns = useAppStore((s) => s.recentScheduledRuns);
  const loadScheduledTasks = useAppStore((s) => s.loadScheduledTasks);
  const openModal = useAppStore((s) => s.openModal);
  const workspaces = useAppStore((s) => s.workspaces);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);

  // 1s ticker for countdowns and progress bars.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);

  // The list is kept live by the global `scheduled-tasks-changed` listener;
  // this just guarantees fresh data when the page opens.
  useEffect(() => {
    void loadScheduledTasks();
  }, [loadScheduledTasks]);

  // Session names (including archived ones, which past runs may point at),
  // keyed by id. Kept page-local: pushing archived sessions into the store
  // would surface them as tabs.
  const [sessionInfo, setSessionInfo] = useState<Record<string, ChatSession>>({});
  const taskWorkspaceIds = useMemo(
    () => [...new Set(scheduledTasks.map((task) => task.workspace_id))].sort().join(","),
    [scheduledTasks],
  );
  useEffect(() => {
    if (!taskWorkspaceIds) return;
    let cancelled = false;
    for (const wsId of taskWorkspaceIds.split(",")) {
      listChatSessions(wsId, true)
        .then((list) => {
          if (cancelled) return;
          setSessionInfo((prev) => {
            const next = { ...prev };
            for (const session of list) next[session.id] = session;
            return next;
          });
        })
        .catch(() => {
          // Rows fall back to a short session id; not worth surfacing.
        });
    }
    return () => {
      cancelled = true;
    };
    // Re-read when runs change too: a new-session fire creates a session.
  }, [taskWorkspaceIds, recentRuns]);

  const sessionName = (_workspaceId: string, sessionId: string): string =>
    sessionInfo[sessionId]?.name || sessionId.slice(0, 8);

  const isRunning = (task: ScheduledTask): boolean => {
    const sid = liveSessionId(task);
    if (!sid) return false;
    const live = sessionsByWorkspace[task.workspace_id]?.find((s) => s.id === sid);
    return (live ?? sessionInfo[sid])?.agent_status === "Running";
  };

  const statusById = new Map<string, TaskStatus>(
    scheduledTasks.map((task) => [task.id, taskStatus(task, isRunning(task))]),
  );
  const statusOf = (task: ScheduledTask): TaskStatus => statusById.get(task.id) ?? "active";
  const summary = summarize(scheduledTasks, statusOf);

  const visible = scheduledTasks
    .filter((task) => matchesFilter(task, statusOf(task), filter, query, workspaceFilter))
    .sort((a, b) => (a.next_fire_at || "~").localeCompare(b.next_fire_at || "~"));
  const loops = visible.filter((task) => task.kind === "cron" && task.recurring);
  const schedules = visible.filter((task) => !(task.kind === "cron" && task.recurring));
  const finished = scheduledTasks.filter((task) => statusOf(task) === "done");

  const workspaceLabel = (id: string): string => {
    const ws = workspaces.find((w) => w.id === id);
    return ws ? ws.branch_name : id.slice(0, 8);
  };

  const targetLabel = (task: ScheduledTask): string => {
    if (task.create_new_session) return t("target_new_session");
    if (!task.chat_session_id) return "—";
    return sessionName(task.workspace_id, task.chat_session_id);
  };

  const backendLabel = (task: ScheduledTask): string | null => {
    if (!task.backend_id) return null;
    return agentBackends.find((b) => b.id === task.backend_id)?.label ?? task.backend_id;
  };

  const taskTitle = (taskId: string): string => {
    const task = scheduledTasks.find((x) => x.id === taskId);
    if (!task) return t("deleted_task");
    return task.name || task.prompt.split("\n")[0];
  };

  const openSession = async (workspaceId: string, sessionId: string) => {
    setError(null);
    const store = useAppStore.getState();
    let session: ChatSession | undefined =
      store.sessionsByWorkspace[workspaceId]?.find((s) => s.id === sessionId) ??
      sessionInfo[sessionId];
    if (!session) {
      try {
        session = await getChatSession(sessionId);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    if (session.status === "Archived") {
      setError(t("session_archived"));
      return;
    }
    if (!store.sessionsByWorkspace[workspaceId]?.some((s) => s.id === sessionId)) {
      store.addChatSession(session);
    }
    store.selectWorkspace(workspaceId);
    store.selectSession(workspaceId, sessionId);
  };

  // Every action resyncs through the backend's change event; the explicit
  // reload in `finally` covers a dropped event.
  const act = async (task: ScheduledTask, fn: (id: string) => Promise<unknown>) => {
    setBusyId(task.id);
    setError(null);
    try {
      await fn(task.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
      void loadScheduledTasks();
    }
  };

  const clearFinished = async () => {
    setError(null);
    try {
      await Promise.all(finished.map((task) => deleteScheduledRoutine(task.id)));
    } catch (e) {
      setError(String(e));
    } finally {
      void loadScheduledTasks();
    }
  };

  const filterWorkspaces = workspaces.filter((w) =>
    scheduledTasks.some((task) => task.workspace_id === w.id),
  );
  const hasAny = scheduledTasks.length > 0;

  const renderRows = (tasks: ScheduledTask[]) => (
    <ul className={styles.list}>
      {tasks.map((task) => (
        <SchedulerTaskRow
          key={task.id}
          task={task}
          status={statusOf(task)}
          now={now}
          workspaceLabel={workspaceLabel(task.workspace_id)}
          targetLabel={targetLabel(task)}
          backendLabel={backendLabel(task)}
          busy={busyId === task.id}
          refreshKey={scheduledTasks}
          sessionName={sessionName}
          onOpenSession={(ws, sid) => void openSession(ws, sid)}
          onRun={(x) => void act(x, runScheduledRoutine)}
          onPause={(x) => void act(x, pauseScheduledRoutine)}
          onResume={(x) => void act(x, resumeScheduledRoutine)}
          onDelete={(x) => void act(x, deleteScheduledRoutine)}
          t={t}
        />
      ))}
    </ul>
  );

  return (
    <div className={styles.page}>
      <PanelHeader
        left={<span className={styles.title}>{t("title")}</span>}
        right={<PanelToggles />}
      />
      <BoundedScrollPane className={styles.body}>
        <div className={styles.summary}>
          <SummaryTile
            icon={<Repeat size={13} />}
            value={summary.looping}
            label={t("summary_looping")}
          />
          <SummaryTile
            icon={<CalendarClock size={13} />}
            value={summary.scheduled}
            label={t("summary_scheduled")}
          />
          <SummaryTile
            icon={<Activity size={13} />}
            value={summary.running}
            label={t("summary_running")}
            tone={summary.running > 0 ? "running" : undefined}
          />
          <SummaryTile
            icon={<AlertTriangle size={13} />}
            value={summary.attention}
            label={t("summary_attention")}
            tone={summary.attention > 0 ? "attention" : undefined}
            onClick={summary.attention > 0 ? () => setFilter("attention") : undefined}
          />
          <div className={styles.nextUp}>
            <Timer size={13} />
            {summary.nextUp ? (
              <span>
                {t("summary_next_up", {
                  title: summary.nextUp.name || summary.nextUp.prompt.split("\n")[0],
                  time: formatCountdown(summary.nextUp.next_fire_at, now),
                })}
              </span>
            ) : (
              <span className={styles.faint}>{t("summary_nothing_armed")}</span>
            )}
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.filterChips} role="group" aria-label={t("filter_label")}>
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? styles.chipActive : styles.chip}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {t(`filter_${f}`)}
                {f === "attention" && summary.attention > 0 && (
                  <span className={styles.chipCount}>{summary.attention}</span>
                )}
                {f === "paused" && summary.paused > 0 && (
                  <span className={styles.chipCount}>{summary.paused}</span>
                )}
              </button>
            ))}
          </div>
          {filterWorkspaces.length > 1 && (
            <select
              className={styles.select}
              value={workspaceFilter ?? ""}
              onChange={(e) => setWorkspaceFilter(e.target.value || null)}
              aria-label={t("filter_workspace")}
            >
              <option value="">{t("filter_all_workspaces")}</option>
              {filterWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.branch_name}
                </option>
              ))}
            </select>
          )}
          <label className={styles.search}>
            <Search size={12} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search_placeholder")}
              aria-label={t("search_placeholder")}
            />
          </label>
          <div className={styles.toolbarRight}>
            {finished.length > 0 && (
              <button
                type="button"
                className={styles.btn}
                onClick={() => void clearFinished()}
                title={t("clear_finished_title")}
              >
                <Eraser size={13} />
                {t("clear_finished", { n: finished.length })}
              </button>
            )}
            <button
              type="button"
              className={styles.btn}
              onClick={() => void loadScheduledTasks()}
              title={t("refresh")}
              aria-label={t("refresh")}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => openModal("createScheduledTask")}
            >
              <Plus size={13} />
              {t("new_btn")}
            </button>
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <Repeat size={12} />
            <span>{t("loops_heading")}</span>
            <span className={styles.count}>{loops.length}</span>
          </div>
          {loops.length === 0 ? (
            <p className={styles.empty}>{hasAny ? t("filtered_empty") : t("loops_empty")}</p>
          ) : (
            renderRows(loops)
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <CalendarClock size={12} />
            <span>{t("schedules_heading")}</span>
            <span className={styles.count}>{schedules.length}</span>
          </div>
          {schedules.length === 0 ? (
            <p className={styles.empty}>
              {hasAny ? t("filtered_empty") : t("schedules_empty")}
            </p>
          ) : (
            renderRows(schedules)
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <History size={12} />
            <span>{t("activity_heading")}</span>
            <span className={styles.count}>{recentRuns.length}</span>
          </div>
          {recentRuns.length === 0 ? (
            <p className={styles.empty}>{t("activity_empty")}</p>
          ) : (
            <ul className={styles.runList}>
              {recentRuns.map((run) => {
                const task = scheduledTasks.find((x) => x.id === run.task_id);
                return (
                  <RunItem
                    key={run.id}
                    run={run}
                    workspaceId={task?.workspace_id ?? ""}
                    now={now}
                    title={taskTitle(run.task_id)}
                    sessionName={sessionName}
                    onOpenSession={(ws, sid) => void openSession(ws, sid)}
                    t={t}
                  />
                );
              })}
            </ul>
          )}
        </section>
      </BoundedScrollPane>
    </div>
  );
}

function SummaryTile({
  icon,
  value,
  label,
  tone,
  onClick,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  tone?: "running" | "attention";
  onClick?: () => void;
}) {
  const className = `${styles.tile} ${tone ? styles[`tile_${tone}`] : ""}`;
  const body = (
    <>
      <span className={styles.tileIcon}>{icon}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileLabel}>{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}
