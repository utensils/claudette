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
}

export interface TaskTrackerWithHistory {
  current: TaskTrackerResult;
  history: TaskRun[];
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
const EMPTY_WITH_HISTORY: TaskTrackerWithHistory = {
  current: EMPTY_RESULT,
  history: [],
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
 *  deprecated alias). Older callers and our own tests have used plain `id`.
 *  Accept all of them so the tracker stays robust across schema drift. */
function extractInputTaskId(input: Record<string, unknown>): string {
  const raw = input.taskId ?? input.task_id ?? input.id ?? input.shell_id;
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
          if (typeof input.description === "string")
            existing.description = input.description;
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

function deriveTaskStateFromEntries(
  entries: { activities: ToolActivity[]; turnId?: string }[],
): TaskTrackerWithHistory {
  const taskMap = new Map<string, TrackedTask>();
  const todoMap = new Map<string, TrackedTask>();
  const nextSyntheticId = { value: 1 };
  const history: TaskRun[] = [];
  let todoRun: TodoRunDraft | null = null;
  let runSequence = 1;

  for (const entry of entries) {
    for (const act of entry.activities) {
      if (act.toolName !== "TodoWrite") {
        processActivities([act], taskMap, todoMap, nextSyntheticId);
        continue;
      }

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
    }
  }

  const tasks = [...taskMap.values(), ...todoMap.values()];
  return {
    current: taskResult(tasks),
    history,
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
