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

const EMPTY_ACTIVITIES: ToolActivity[] = [];
const EMPTY_TURNS: CompletedTurn[] = [];
const EMPTY_RESULT: TaskTrackerResult = {
  tasks: [],
  completedCount: 0,
  totalCount: 0,
};

/** Normalise status strings from Claude's TaskCreate/TaskUpdate/TodoWrite inputs. */
function normalizeStatus(raw: string | undefined): TaskStatus {
  if (!raw) return "pending";
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "_");
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "started" || s === "running") return "in_progress";
  if (s === "blocked") return "blocked";
  if (s === "cancelled" || s === "canceled" || s === "stopped") return "cancelled";
  return "pending";
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
function processActivities(
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
          description: String(input.description ?? ""),
          status: normalizeStatus(input.status as string | undefined),
          source: "task",
        });
        break;
      }
      case "TaskUpdate": {
        const id = String(input.id ?? "");
        const existing = taskMap.get(id);
        if (existing) {
          if (input.status) existing.status = normalizeStatus(input.status as string);
          if (input.description) existing.description = String(input.description);
        } else if (id) {
          // Orphaned update (TaskCreate result not yet available) — create a stub
          taskMap.set(id, {
            id,
            description: String(input.description ?? `Task #${id}`),
            status: normalizeStatus(input.status as string | undefined),
            source: "task",
          });
        }
        break;
      }
      case "TaskStop": {
        const id = String(input.id ?? "");
        const existing = taskMap.get(id);
        if (existing) {
          existing.status = "cancelled";
        }
        break;
      }
      case "TodoWrite": {
        const todos = input.todos;
        if (!Array.isArray(todos)) break;
        // TodoWrite is a full replacement — clear all previous todo items
        todoMap.clear();
        for (const item of todos) {
          if (!item || typeof item !== "object") continue;
          const id = String(
            (item as Record<string, unknown>).id ?? `_d${nextSyntheticId.value++}`
          );
          todoMap.set(id, {
            id,
            description: String((item as Record<string, unknown>).content ?? ""),
            status: normalizeStatus((item as Record<string, unknown>).status as string | undefined),
            priority: normalizePriority((item as Record<string, unknown>).priority as string | undefined),
            source: "todo",
          });
        }
        break;
      }
    }
  }
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
  if (tasks.length === 0) return EMPTY_RESULT;

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  return { tasks, completedCount, totalCount: tasks.length };
}

/**
 * Reactively derive a task list from existing tool activities.
 * Scans both completed turns and current-turn activities for
 * TaskCreate, TaskUpdate, TaskStop, and TodoWrite tool calls.
 */
export function useTaskTracker(wsId: string | null): TaskTrackerResult {
  const completedTurns = useAppStore(
    (s) => (wsId ? s.completedTurns[wsId] : null) ?? EMPTY_TURNS
  );
  const toolActivities = useAppStore(
    (s) => (wsId ? s.toolActivities[wsId] : null) ?? EMPTY_ACTIVITIES
  );

  return useMemo(
    () => (wsId ? deriveTasks(completedTurns, toolActivities) : EMPTY_RESULT),
    [wsId, completedTurns, toolActivities]
  );
}
