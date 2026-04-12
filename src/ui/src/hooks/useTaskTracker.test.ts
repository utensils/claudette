import { describe, it, expect } from "vitest";
import { deriveTasks, extractTaskId } from "./useTaskTracker";
import type { ToolActivity, CompletedTurn } from "../stores/useAppStore";

/** Helper to build a minimal ToolActivity. */
function activity(
  toolName: string,
  inputJson: Record<string, unknown>,
  resultText = ""
): ToolActivity {
  return {
    toolUseId: crypto.randomUUID(),
    toolName,
    inputJson: JSON.stringify(inputJson),
    resultText,
    collapsed: true,
    summary: "",
  };
}

/** Helper to wrap activities into a CompletedTurn. */
function turn(activities: ToolActivity[]): CompletedTurn {
  return {
    id: crypto.randomUUID(),
    activities,
    messageCount: 1,
    collapsed: false,
    afterMessageIndex: 0,
  };
}

// ── extractTaskId ─────────────────────────────────────────────

describe("extractTaskId", () => {
  it("extracts from JSON with task_id field", () => {
    expect(extractTaskId('{"task_id": 3}')).toBe("3");
  });

  it("extracts from JSON with id field", () => {
    expect(extractTaskId('{"id": 7}')).toBe("7");
  });

  it('extracts from "Created task 3"', () => {
    expect(extractTaskId("Created task 3")).toBe("3");
  });

  it('extracts from "task #42"', () => {
    expect(extractTaskId("task #42")).toBe("42");
  });

  it('extracts from "Task ID: 5"', () => {
    expect(extractTaskId("id: 5")).toBe("5");
  });

  it("returns null for empty string", () => {
    expect(extractTaskId("")).toBeNull();
  });

  it("returns null for unrecognised text", () => {
    expect(extractTaskId("something unrelated")).toBeNull();
  });
});

// ── deriveTasks ───────────────────────────────────────────────

describe("deriveTasks", () => {
  it("returns empty result when no task tools are present", () => {
    const activities = [
      activity("Bash", { command: "ls" }),
      activity("Read", { file_path: "/tmp/foo" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it("handles basic TaskCreate", () => {
    const activities = [
      activity(
        "TaskCreate",
        { description: "Implement feature X" },
        '{"task_id": 1}'
      ),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      id: "1",
      description: "Implement feature X",
      status: "pending",
      source: "task",
    });
  });

  it("handles TaskCreate → TaskUpdate flow", () => {
    const activities = [
      activity(
        "TaskCreate",
        { description: "Write tests" },
        '{"task_id": 1}'
      ),
      activity("TaskUpdate", { id: "1", status: "in_progress" }),
      activity("TaskUpdate", { id: "1", status: "completed" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.tasks[0].status).toBe("completed");
  });

  it("handles TaskStop", () => {
    const activities = [
      activity("TaskCreate", { description: "Work" }, '{"task_id": 1}'),
      activity("TaskStop", { id: "1" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].status).toBe("cancelled");
  });

  it("creates stub for orphaned TaskUpdate", () => {
    const activities = [
      activity("TaskUpdate", { id: "99", status: "in_progress" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      id: "99",
      description: "Task #99",
      status: "in_progress",
      source: "task",
    });
  });

  it("handles TodoWrite full replacement", () => {
    const first = [
      activity("TodoWrite", {
        todos: [
          { id: "a", content: "First", status: "pending" },
          { id: "b", content: "Second", status: "completed" },
        ],
      }),
    ];
    const second = [
      activity("TodoWrite", {
        todos: [
          { id: "c", content: "Replaced", status: "in_progress" },
        ],
      }),
    ];
    const result = deriveTasks([turn(first)], second);
    // First TodoWrite should be fully replaced by second
    expect(result.totalCount).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      id: "c",
      description: "Replaced",
      status: "in_progress",
      source: "todo",
    });
  });

  it("handles TodoWrite with priority", () => {
    const activities = [
      activity("TodoWrite", {
        todos: [
          { id: "1", content: "Urgent", status: "pending", priority: "high" },
          { id: "2", content: "Later", status: "pending", priority: "low" },
        ],
      }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].priority).toBe("high");
    expect(result.tasks[1].priority).toBe("low");
  });

  it("merges task and todo sources", () => {
    const activities = [
      activity("TaskCreate", { description: "A task" }, '{"task_id": 1}'),
      activity("TodoWrite", {
        todos: [{ id: "t1", content: "A todo", status: "pending" }],
      }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(2);
    expect(result.tasks.map((t) => t.source)).toEqual(["task", "todo"]);
  });

  it("processes completed turns before current activities", () => {
    const historicalTurn = turn([
      activity("TaskCreate", { description: "Old task" }, '{"task_id": 1}'),
    ]);
    const currentActivities = [
      activity("TaskUpdate", { id: "1", status: "completed" }),
    ];
    const result = deriveTasks([historicalTurn], currentActivities);
    expect(result.tasks[0].status).toBe("completed");
    expect(result.tasks[0].description).toBe("Old task");
  });

  it("skips malformed JSON gracefully", () => {
    const activities: ToolActivity[] = [
      {
        toolUseId: "x",
        toolName: "TaskCreate",
        inputJson: "not-json{{{",
        resultText: "",
        collapsed: true,
        summary: "",
      },
      activity("TaskCreate", { description: "Valid" }, '{"task_id": 2}'),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(1);
    expect(result.tasks[0].description).toBe("Valid");
  });

  it("handles TodoWrite with non-array todos field", () => {
    const activities = [
      activity("TodoWrite", { todos: "not-an-array" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(0);
  });

  it("normalizes various status strings", () => {
    const activities = [
      activity("TaskCreate", { description: "A", status: "done" }, '{"task_id": 1}'),
      activity("TaskCreate", { description: "B", status: "started" }, '{"task_id": 2}'),
      activity("TaskCreate", { description: "C", status: "canceled" }, '{"task_id": 3}'),
      activity("TaskCreate", { description: "D", status: "running" }, '{"task_id": 4}'),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].status).toBe("completed");
    expect(result.tasks[1].status).toBe("in_progress");
    expect(result.tasks[2].status).toBe("cancelled");
    expect(result.tasks[3].status).toBe("in_progress");
  });

  it("assigns synthetic IDs when result text has no ID", () => {
    const activities = [
      activity("TaskCreate", { description: "No ID" }, ""),
      activity("TaskCreate", { description: "Also no ID" }, "something"),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(2);
    expect(result.tasks[0].id).toBe("_t1");
    expect(result.tasks[1].id).toBe("_t2");
  });
});
