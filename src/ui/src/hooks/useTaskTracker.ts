import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import type { ToolActivity, CompletedTurn } from "../stores/useAppStore";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled";

export interface TrackedTask {
  id: string;
  description: string;
  status: TaskStatus;
  priority?: "high" | "medium" | "low";
  source: "task" | "todo";
}

export interface TaskTrackerResult {
  tasks: TrackedTask[];
  completedCount: number;
  totalCount: number;
}

export interface TaskRun extends TaskTrackerResult {
  id: string;
  sequence: number;
  startedAt?: string;
  updatedAt?: string;
  turnId?: string;
  /// Optional display label. Set by the subagent-archive path so the
  /// history section can render the agent's description (e.g.
  /// "Agent A: build pagination") instead of the generic "Run N".
  /// Absent for TodoWrite-replacement and main-agent delete-burst runs.
  label?: string;
}

export interface TaskTrackerWithHistory {
  current: TaskTrackerResult;
  history: TaskRun[];
  /// Per-subagent task buckets. Each Agent tool activity that ran any
  /// Task* / TodoWrite calls inside its `agentToolCalls` array becomes
  /// one entry here, keyed on the parent's `toolUseId` and labelled
  /// with `agentDescription`. Subagent task IDs share the main-agent's
  /// "Task #N" numbering space upstream, so the right-sidebar renders
  /// them in separate sections to avoid collision.
  subagents: SubagentTaskRun[];
}

export interface SubagentTaskRun extends TaskTrackerResult {
  /// Stable key for React — sourced from the parent Agent activity's
  /// `toolUseId`. Same `toolUseId` across renders → same key.
  id: string;
  /// Display label for the right-sidebar section header. Falls back
  /// to a non-empty placeholder when the parent activity has no
  /// `agentDescription`, so the section can never render blank.
  label: string;
  /// Latest `agentStatus` from the parent activity (running /
  /// completed / failed). UI can use this to dim completed sections.
  status?: string;
}

export interface TaskActivityTurn {
  id: string;
  activities: ToolActivity[];
}

const EMPTY_ACTIVITIES: ToolActivity[] = [];
const EMPTY_TURNS: CompletedTurn[] = [];
const EMPTY_RESULT: TaskTrackerResult = {
  tasks: [],
  completedCount: 0,
  totalCount: 0,
};
const EMPTY_SUBAGENTS: SubagentTaskRun[] = [];

const EMPTY_WITH_HISTORY: TaskTrackerWithHistory = {
  current: EMPTY_RESULT,
  history: [],
  subagents: EMPTY_SUBAGENTS,
};

/** Normalise status strings from Claude's TaskCreate/TaskUpdate/TodoWrite inputs. */
function normalizeStatus(raw: string | undefined): TaskStatus {
  if (!raw) return "pending";
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "_");
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "started" || s === "running") return "in_progress";
  if (s === "blocked") return "blocked";
  if (
    s === "cancelled" ||
    s === "canceled" ||
    s === "stopped" ||
    s === "deleted"
  )
    return "cancelled";
  return "pending";
}

/** Extract the task id from a TaskUpdate / TaskStop / TaskGet input payload.
 *  Claude Code's own tools are inconsistent: `TaskUpdate`/`TaskGet` use
 *  `taskId`, `TaskStop`/`TaskOutput` use `task_id` (with `shell_id` as a
 *  deprecated alias). Accept that documented surface only — `id` is a
 *  generic JSON key (record id, row id, UUID) and tolerating it here
 *  invites silent mis-binds if any future tool ever lands a TaskUpdate
 *  shape with `id` meaning something else. */
function extractInputTaskId(input: Record<string, unknown>): string {
  const raw = input.taskId ?? input.task_id ?? input.shell_id;
  return raw != null ? String(raw) : "";
}

/** Pick the display label for a TaskCreate. Claude Code emits both
 *  `subject` (brief title) and `description` (longer body); prefer the
 *  brief title so the right-sidebar list stays readable. */
function extractTaskDescription(input: Record<string, unknown>): string {
  const subject = input.subject;
  if (typeof subject === "string" && subject.trim().length > 0) return subject;
  const description = input.description;
  if (typeof description === "string") return description;
  return "";
}

/** Try to extract a numeric task ID from a TaskCreate result string. */
export function extractTaskId(resultText: string): string | null {
  if (!resultText) return null;
  try {
    const parsed = JSON.parse(resultText);
    if (parsed?.task_id != null) return String(parsed.task_id);
    if (parsed?.id != null) return String(parsed.id);
  } catch {
    // Not JSON — try regex
  }
  // Match patterns like "Created task 3", "task #3", "Task ID: 3"
  const match = resultText.match(/(?:task\s*#?\s*|id[:\s]+)(\d+)/i);
  return match ? match[1] : null;
}

/** Scan a list of tool activities and update the task/todo maps. */
export function processActivities(
  activities: ToolActivity[],
  taskMap: Map<string, TrackedTask>,
  todoMap: Map<string, TrackedTask>,
  nextSyntheticId: { value: number }
) {
  for (const act of activities) {
    if (
      act.toolName !== "TaskCreate" &&
      act.toolName !== "TaskUpdate" &&
      act.toolName !== "TaskStop" &&
      act.toolName !== "TodoWrite"
    ) {
      continue;
    }

    let input: Record<string, unknown>;
    try {
      input = JSON.parse(act.inputJson);
    } catch {
      continue;
    }

    switch (act.toolName) {
      case "TaskCreate": {
        const id =
          extractTaskId(act.resultText) ?? `_t${nextSyntheticId.value++}`;
        taskMap.set(id, {
          id,
          description: extractTaskDescription(input),
          status: normalizeStatus(input.status as string | undefined),
          priority: normalizePriority(input.priority as string | undefined),
          source: "task",
        });
        break;
      }
      case "TaskUpdate": {
        const id = extractInputTaskId(input);
        // `status: "deleted"` means the agent deleted the task server-side;
        // drop it from the map rather than rendering it as cancelled.
        const rawStatus =
          typeof input.status === "string" ? input.status : undefined;
        if (rawStatus && rawStatus.toLowerCase() === "deleted") {
          if (id) taskMap.delete(id);
          break;
        }
        const existing = taskMap.get(id);
        if (existing) {
          if (rawStatus) existing.status = normalizeStatus(rawStatus);
          // TaskUpdate.description is the long body, not the title.
          // The display label was set from TaskCreate.subject and must
          // stay sticky — otherwise the sidebar entry silently swaps
          // from "Implement feature X" to a multi-paragraph essay.
          // Only honour an explicit `subject` (not currently in the
          // upstream TaskUpdate schema, but defensive against drift).
          if (typeof input.subject === "string" && input.subject.trim())
            existing.description = input.subject;
          if (input.priority)
            existing.priority = normalizePriority(input.priority as string);
        } else if (id) {
          // Orphaned update (TaskCreate result not yet available) — create a stub
          taskMap.set(id, {
            id,
            description: extractTaskDescription(input) || `Task #${id}`,
            status: normalizeStatus(rawStatus),
            priority: normalizePriority(input.priority as string | undefined),
            source: "task",
          });
        }
        break;
      }
      case "TaskStop": {
        const id = extractInputTaskId(input);
        const existing = taskMap.get(id);
        if (existing) {
          existing.status = "cancelled";
        }
        break;
      }
      case "TodoWrite": {
        const todos = input.todos;
        if (!Array.isArray(todos)) break;
        todoMap.clear();
        for (const task of parseTodoTasks(todos, nextSyntheticId)) {
          todoMap.set(task.id, task);
        }
        break;
      }
    }
  }
}

function parseTodoTasks(
  todos: unknown[],
  nextSyntheticId: { value: number },
): TrackedTask[] {
  const tasks: TrackedTask[] = [];
  for (const item of todos) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = String(raw.id ?? `_d${nextSyntheticId.value++}`);
    tasks.push({
      id,
      description: String(raw.content ?? ""),
      status: normalizeStatus(raw.status as string | undefined),
      priority: normalizePriority(raw.priority as string | undefined),
      source: "todo",
    });
  }
  return tasks;
}

function normalizePriority(
  raw: string | undefined
): "high" | "medium" | "low" | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "high" || s === "h") return "high";
  if (s === "low" || s === "l") return "low";
  if (s === "medium" || s === "m" || s === "med") return "medium";
  return undefined;
}

function taskResult(tasks: TrackedTask[]): TaskTrackerResult {
  if (tasks.length === 0) return EMPTY_RESULT;
  return {
    tasks,
    completedCount: tasks.filter((t) => t.status === "completed").length,
    totalCount: tasks.length,
  };
}

interface TodoRunDraft {
  id: string;
  sequence: number;
  tasks: TrackedTask[];
  startedAt?: string;
  updatedAt?: string;
  turnId?: string;
}

function normalizeTaskContent(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function taskContentSet(tasks: TrackedTask[]): Set<string> {
  return new Set(
    tasks
      .map((task) => normalizeTaskContent(task.description))
      .filter(Boolean),
  );
}

function isReplacedTodoRun(previous: TrackedTask[], next: TrackedTask[]): boolean {
  if (previous.length === 0 || next.length === 0) return false;

  const previousSet = taskContentSet(previous);
  const nextSet = taskContentSet(next);
  if (previousSet.size === 0 || nextSet.size === 0) return false;

  let intersection = 0;
  for (const item of previousSet) {
    if (nextSet.has(item)) intersection++;
  }

  if (Math.min(previousSet.size, nextSet.size) <= 1) {
    return intersection === 0;
  }

  const union = new Set([...previousSet, ...nextSet]).size;
  return union > 0 && intersection / union < 0.25;
}

function finalizeTodoRun(run: TodoRunDraft): TaskRun {
  const result = taskResult(run.tasks);
  return {
    ...result,
    id: run.id,
    sequence: run.sequence,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    turnId: run.turnId,
  };
}

/** Build a single subagent task bucket from the parent Agent activity.
 *  Returns `null` when the activity has no task-related nested calls.
 *
 *  Subagent calls land in `activity.agentToolCalls`, not at the top
 *  level. The shape differs from top-level activities in two ways
 *  (verified against live dev-app data):
 *    1. `input` is already a parsed object — no JSON.parse needed.
 *    2. `TaskCreate` response is the parsed `{ task: { id, subject } }`
 *       struct stored in `call.response`, not a textual
 *       `"Task #N created..."` string in `resultText`.
 *
 *  Mirrors the per-tool semantics from `processActivities` /
 *  `deriveTaskStateFromEntries` so subagent task lists behave the
 *  same as the main agent's — status flips, deletions, todo writes,
 *  and orphaned-update stubs all work identically.
 */
function deriveSubagentRunFromActivity(
  activity: ToolActivity,
  syntheticIdSeed: { value: number },
): SubagentTaskRun | null {
  const calls = activity.agentToolCalls;
  if (!calls || calls.length === 0) return null;

  const taskMap = new Map<string, TrackedTask>();
  const todoMap = new Map<string, TrackedTask>();

  for (const call of calls) {
    if (!TASK_TOOL_NAMES.has(call.toolName)) continue;
    const rawInput = call.input;
    if (!rawInput || typeof rawInput !== "object") continue;
    const input = rawInput as Record<string, unknown>;

    switch (call.toolName) {
      case "TaskCreate": {
        // Subagent TaskCreate carries the assigned id in `response.task.id`
        // (already a parsed object), unlike the top-level form where it
        // lives in `resultText`. Fall through to a synthetic id when the
        // response shape is unexpected (e.g. status: "failed").
        const response = call.response as
          | { task?: { id?: unknown } | null }
          | null
          | undefined;
        const responseId =
          response?.task && response.task.id != null
            ? String(response.task.id)
            : null;
        const id = responseId ?? `_st${syntheticIdSeed.value++}`;
        taskMap.set(id, {
          id,
          description: extractTaskDescription(input),
          status: normalizeStatus(input.status as string | undefined),
          priority: normalizePriority(input.priority as string | undefined),
          source: "task",
        });
        break;
      }
      case "TaskUpdate": {
        const id = extractInputTaskId(input);
        const rawStatus =
          typeof input.status === "string" ? input.status : undefined;
        if (rawStatus && rawStatus.toLowerCase() === "deleted") {
          if (id) taskMap.delete(id);
          break;
        }
        const existing = taskMap.get(id);
        if (existing) {
          if (rawStatus) existing.status = normalizeStatus(rawStatus);
          // Same rule as the main-agent path: TaskUpdate.description
          // is the long body, not the title. Keep the existing
          // subject-derived label sticky.
          if (typeof input.subject === "string" && input.subject.trim())
            existing.description = input.subject;
          if (input.priority)
            existing.priority = normalizePriority(input.priority as string);
        } else if (id) {
          taskMap.set(id, {
            id,
            description: extractTaskDescription(input) || `Task #${id}`,
            status: normalizeStatus(rawStatus),
            priority: normalizePriority(input.priority as string | undefined),
            source: "task",
          });
        }
        break;
      }
      case "TaskStop": {
        const id = extractInputTaskId(input);
        const existing = taskMap.get(id);
        if (existing) existing.status = "cancelled";
        break;
      }
      case "TodoWrite": {
        const todos = input.todos;
        if (!Array.isArray(todos)) break;
        todoMap.clear();
        for (const task of parseTodoTasks(todos, syntheticIdSeed)) {
          todoMap.set(task.id, task);
        }
        break;
      }
    }
  }

  const tasks = [...taskMap.values(), ...todoMap.values()];
  if (tasks.length === 0) return null;

  return {
    ...taskResult(tasks),
    id: activity.toolUseId,
    // Never render blank: fall back through the activity's own metadata
    // so subagents that arrived without a description still get a chip.
    label:
      activity.agentDescription?.trim() ||
      activity.toolName ||
      `Subagent ${activity.toolUseId.slice(0, 8)}`,
    status: activity.agentStatus ?? undefined,
  };
}

function deriveTaskStateFromEntries(
  entries: { activities: ToolActivity[]; turnId?: string }[],
): TaskTrackerWithHistory {
  const taskMap = new Map<string, TrackedTask>();
  const todoMap = new Map<string, TrackedTask>();
  const nextSyntheticId = { value: 1 };
  const history: TaskRun[] = [];
  let todoRun: TodoRunDraft | null = null;
  let runSequence = 1;

  // Buffer of tasks deleted via `TaskUpdate({ status: "deleted" })` since
  // the last flush. Upstream Claude Code uses delete-burst + fresh
  // `TaskCreate` instead of TodoWrite's "replace whole list" pattern,
  // so we mirror the same archive flow here: when the agent fully
  // empties `taskMap` and then starts creating again, the cleared
  // batch graduates into `history` as a `TaskRun`. Partial deletions
  // (where some original tasks survive) are treated as refinements,
  // not run boundaries, and the buffer is discarded.
  let pendingTaskDeletions: TrackedTask[] = [];
  let taskRunStartedAt: string | undefined;
  let taskRunUpdatedAt: string | undefined;
  let taskRunTurnId: string | undefined;

  const resetPendingTaskRun = () => {
    pendingTaskDeletions = [];
    taskRunStartedAt = undefined;
    taskRunUpdatedAt = undefined;
    taskRunTurnId = undefined;
  };

  const flushPendingTaskDeletions = () => {
    if (pendingTaskDeletions.length === 0) return;
    const result = taskResult(pendingTaskDeletions);
    history.push({
      ...result,
      id: `task-run-${runSequence}`,
      sequence: runSequence++,
      startedAt: taskRunStartedAt,
      updatedAt: taskRunUpdatedAt,
      turnId: taskRunTurnId,
    });
    resetPendingTaskRun();
  };

  /** "Live" tasks are anything in taskMap that hasn't been cancelled
   *  via TaskStop. If they remain, the deletion/stop activity was a
   *  refinement (some originals still in play) and we drop the buffer
   *  silently; otherwise the batch has been fully cleared and we
   *  archive the pending deletions plus any cancelled survivors as a
   *  single history run. Idempotent — safe to call at every TaskCreate
   *  boundary and again at end-of-stream. */
  const maybeArchivePendingBatch = () => {
    if (pendingTaskDeletions.length === 0) return;
    const live: TrackedTask[] = [];
    const cancelled: TrackedTask[] = [];
    for (const t of taskMap.values()) {
      if (t.status === "cancelled") cancelled.push(t);
      else live.push(t);
    }
    if (live.length > 0) {
      resetPendingTaskRun();
      return;
    }
    // No survivors — fold any cancelled (but-still-in-map) tasks into
    // the same archive run so the user sees the whole batch's final
    // state in history. Mutating taskMap is safe here because we'll
    // exit the loop or hit the next TaskCreate immediately after.
    for (const t of cancelled) {
      pendingTaskDeletions.push({ ...t });
      taskMap.delete(t.id);
    }
    flushPendingTaskDeletions();
  };

  for (const entry of entries) {
    for (const act of entry.activities) {
      if (act.toolName === "TodoWrite") {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(act.inputJson);
        } catch {
          continue;
        }
        const todos = input.todos;
        if (!Array.isArray(todos)) continue;

        const tasks = parseTodoTasks(todos, nextSyntheticId);
        todoMap.clear();
        for (const task of tasks) {
          todoMap.set(task.id, task);
        }

        if (tasks.length === 0) {
          if (todoRun) {
            history.push(finalizeTodoRun(todoRun));
            todoRun = null;
          }
          continue;
        }

        if (!todoRun) {
          todoRun = {
            id: `todo-run-${runSequence}`,
            sequence: runSequence++,
            tasks,
            startedAt: act.startedAt,
            updatedAt: act.startedAt,
            turnId: entry.turnId,
          };
          continue;
        }

        if (isReplacedTodoRun(todoRun.tasks, tasks)) {
          history.push(finalizeTodoRun(todoRun));
          todoRun = {
            id: `todo-run-${runSequence}`,
            sequence: runSequence++,
            tasks,
            startedAt: act.startedAt,
            updatedAt: act.startedAt,
            turnId: entry.turnId,
          };
        } else {
          todoRun = {
            ...todoRun,
            tasks,
            updatedAt: act.startedAt ?? todoRun.updatedAt,
            turnId: entry.turnId,
          };
        }
        continue;
      }

      if (act.toolName === "TaskUpdate") {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(act.inputJson);
        } catch {
          continue;
        }
        const rawStatus =
          typeof input.status === "string" ? input.status : undefined;
        if (rawStatus && rawStatus.toLowerCase() === "deleted") {
          const id = extractInputTaskId(input);
          const existing = id ? taskMap.get(id) : undefined;
          if (existing) {
            // Snapshot the task as-of deletion so the history entry
            // shows the user's last-known progress (e.g. completed
            // tasks stay "completed" in the archive).
            pendingTaskDeletions.push({ ...existing });
            taskMap.delete(id);
            if (!taskRunStartedAt) taskRunStartedAt = act.startedAt;
            taskRunUpdatedAt = act.startedAt ?? taskRunUpdatedAt;
            if (!taskRunTurnId) taskRunTurnId = entry.turnId;
          }
          continue;
        }
        // Non-deleted TaskUpdate (status flips, blocked-by edits, etc.)
        // is a plain in-place mutation — delegate to the shared handler.
        processActivities([act], taskMap, todoMap, nextSyntheticId);
        continue;
      }

      if (act.toolName === "TaskStop") {
        // TaskStop is the subagent's "close the list" signal — they
        // rarely call TaskUpdate(deleted). Treat it as a run-boundary
        // contributor the same way deletions are: snapshot the task
        // (preserved as `cancelled` in the archive) into the pending
        // buffer and remove it from `taskMap`. The actual flush
        // decision happens at the next TaskCreate / end-of-stream.
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(act.inputJson);
        } catch {
          continue;
        }
        const id = extractInputTaskId(input);
        const existing = id ? taskMap.get(id) : undefined;
        if (existing) {
          pendingTaskDeletions.push({ ...existing, status: "cancelled" });
          taskMap.delete(id);
          if (!taskRunStartedAt) taskRunStartedAt = act.startedAt;
          taskRunUpdatedAt = act.startedAt ?? taskRunUpdatedAt;
          if (!taskRunTurnId) taskRunTurnId = entry.turnId;
        }
        continue;
      }

      if (act.toolName === "TaskCreate") {
        // A fresh TaskCreate arriving while we have pending deletions
        // is the "new batch starting" signal. Archive the deletions
        // only when the previous batch is fully cleared — partial
        // deletions are refinements (the agent dropped one or two
        // tasks but kept working on the rest) and shouldn't pollute
        // history with single-task runs.
        maybeArchivePendingBatch();
        processActivities([act], taskMap, todoMap, nextSyntheticId);
        continue;
      }

      // Other task-related tools — delegate to the shared mutator.
      processActivities([act], taskMap, todoMap, nextSyntheticId);
    }
  }

  // End-of-stream flush mirrors the TaskCreate boundary check so a
  // session that ends on a clearing burst still records history.
  maybeArchivePendingBatch();

  // Per-subagent task buckets. Walk every Agent activity in stream
  // order (past turns first, then current). Running subagents stay in
  // the live `subagents[]` lane so the right-sidebar can render
  // them with progress indicators; everything else (completed,
  // failed, or status-less DB-replayed entries) graduates straight
  // into `history` with a per-subagent label so the user can still
  // find what each subagent did after the fact. Subagents rarely
  // emit `TaskUpdate(deleted)` on their own list before exiting, so
  // status-transition is the only reliable "I'm done" signal we get.
  //
  // De-dupe by `toolUseId`: the same Agent activity could surface in
  // both `completedTurns` and `toolActivities` (`finalizeTurn` clears
  // the latter in practice, but nothing on the data side enforces
  // it). Last write wins — so a transition from "running" in a past
  // turn to "completed" in the current activities collapses to a
  // single history row instead of producing duplicate React keys.
  const latestAgentByToolUseId = new Map<
    string,
    { act: ToolActivity; turnId?: string }
  >();
  const agentToolUseOrder: string[] = [];
  for (const entry of entries) {
    for (const act of entry.activities) {
      if (act.toolName !== "Agent") continue;
      if (!latestAgentByToolUseId.has(act.toolUseId)) {
        agentToolUseOrder.push(act.toolUseId);
      }
      latestAgentByToolUseId.set(act.toolUseId, { act, turnId: entry.turnId });
    }
  }

  const subagents: SubagentTaskRun[] = [];
  for (const toolUseId of agentToolUseOrder) {
    const entry = latestAgentByToolUseId.get(toolUseId)!;
    const run = deriveSubagentRunFromActivity(entry.act, nextSyntheticId);
    if (!run) continue;
    if (run.status === "running") {
      subagents.push(run);
    } else {
      history.push({
        tasks: run.tasks,
        completedCount: run.completedCount,
        totalCount: run.totalCount,
        id: `subagent-${run.id}`,
        sequence: runSequence++,
        label: run.label,
        turnId: entry.turnId,
      });
    }
  }

  const tasks = [...taskMap.values(), ...todoMap.values()];
  return {
    current: taskResult(tasks),
    history,
    subagents,
  };
}

/**
 * Pure derivation: compute task list from completed turns + current activities.
 * Exported for unit testing; the hook version below wraps this with Zustand selectors.
 */
export function deriveTasks(
  completedTurns: CompletedTurn[],
  toolActivities: ToolActivity[]
): TaskTrackerResult {
  const taskMap = new Map<string, TrackedTask>();
  const todoMap = new Map<string, TrackedTask>();
  const nextSyntheticId = { value: 1 };

  for (const turn of completedTurns) {
    processActivities(turn.activities, taskMap, todoMap, nextSyntheticId);
  }
  processActivities(toolActivities, taskMap, todoMap, nextSyntheticId);

  const tasks = [...taskMap.values(), ...todoMap.values()];
  return taskResult(tasks);
}

/**
 * Graduate a `TaskTrackerWithHistory` for a session that's no longer
 * active — typically because the user closed the chat tab. Anything
 * still in `current` (work the session left mid-list) or `subagents`
 * (a subagent that was still "running" when the session closed) gets
 * folded into `history` as additional `TaskRun`s so the workspace's
 * task panel keeps a complete record of what happened in that
 * session. Idempotent: running it on an already-finalized state is
 * safe (no double-counting).
 *
 * Used by `useWorkspaceTaskHistory` for every non-active session.
 */
export function finalizeTaskState(
  state: TaskTrackerWithHistory,
): TaskTrackerWithHistory {
  const extraRuns: TaskRun[] = [];
  let nextSeq =
    state.history.reduce((max, r) => Math.max(max, r.sequence), 0) + 1;

  if (state.current.tasks.length > 0) {
    extraRuns.push({
      tasks: state.current.tasks,
      completedCount: state.current.completedCount,
      totalCount: state.current.totalCount,
      id: `final-current-${nextSeq}`,
      sequence: nextSeq++,
    });
  }
  for (const sub of state.subagents) {
    extraRuns.push({
      tasks: sub.tasks,
      completedCount: sub.completedCount,
      totalCount: sub.totalCount,
      id: `final-subagent-${sub.id}`,
      sequence: nextSeq++,
      label: sub.label,
    });
  }

  if (extraRuns.length === 0) return state;

  return {
    current: EMPTY_RESULT,
    history: [...state.history, ...extraRuns],
    subagents: EMPTY_SUBAGENTS,
  };
}

export function deriveTaskState(
  completedTurns: TaskActivityTurn[],
  toolActivities: ToolActivity[],
): TaskTrackerWithHistory {
  if (completedTurns.length === 0 && toolActivities.length === 0) {
    return EMPTY_WITH_HISTORY;
  }

  return deriveTaskStateFromEntries([
    ...completedTurns.map((turn) => ({
      activities: turn.activities,
      turnId: turn.id,
    })),
    { activities: toolActivities },
  ]);
}

const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "TodoWrite",
]);

/** Check whether a completed turn contains any task-related tool calls. */
export function turnHasTaskActivity(turn: CompletedTurn): boolean {
  return turn.activities.some((a) => TASK_TOOL_NAMES.has(a.toolName));
}

/** Check whether an activities array contains any task-related tool calls. */
export function hasTaskActivity(activities: ToolActivity[]): boolean {
  return activities.some((a) => TASK_TOOL_NAMES.has(a.toolName));
}

/**
 * Reactively derive a task list from existing tool activities.
 * Scans both completed turns and current-turn activities for
 * TaskCreate, TaskUpdate, TaskStop, and TodoWrite tool calls.
 */
export function useTaskTracker(sessionId: string | null): TaskTrackerResult {
  return useTaskTrackerWithHistory(sessionId).current;
}

export function useTaskTrackerWithHistory(
  sessionId: string | null,
): TaskTrackerWithHistory {
  const completedTurns = useAppStore(
    (s) => (sessionId ? s.completedTurns[sessionId] : null) ?? EMPTY_TURNS
  );
  const toolActivities = useAppStore(
    (s) => (sessionId ? s.toolActivities[sessionId] : null) ?? EMPTY_ACTIVITIES
  );

  return useMemo(
    () => (sessionId ? deriveTaskState(completedTurns, toolActivities) : EMPTY_WITH_HISTORY),
    [sessionId, completedTurns, toolActivities]
  );
}
