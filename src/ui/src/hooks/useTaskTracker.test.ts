import { describe, it, expect } from "vitest";
import { deriveTasks, deriveTaskState, extractTaskId } from "./useTaskTracker";
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

// ── deriveTaskState history ──────────────────────────────────

describe("deriveTaskState", () => {
  it("archives a replaced TodoWrite run", () => {
    const first = turn([
      activity("TodoWrite", {
        todos: [
          { content: "Inspect auth flow", status: "completed" },
          { content: "Patch token refresh", status: "completed" },
        ],
      }),
    ]);
    const second = [
      activity("TodoWrite", {
        todos: [
          { content: "Write release notes", status: "in_progress" },
          { content: "Update screenshots", status: "pending" },
        ],
      }),
    ];

    const result = deriveTaskState([first], second);

    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      completedCount: 2,
      totalCount: 2,
    });
    expect(result.history[0].tasks.map((task) => task.description)).toEqual([
      "Inspect auth flow",
      "Patch token refresh",
    ]);
    expect(result.current.tasks.map((task) => task.description)).toEqual([
      "Write release notes",
      "Update screenshots",
    ]);
  });

  it("does not archive status-only TodoWrite updates", () => {
    const first = turn([
      activity("TodoWrite", {
        todos: [
          { content: "Build UI", status: "pending" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    ]);
    const second = [
      activity("TodoWrite", {
        todos: [
          { content: "Run tests", status: "pending" },
          { content: "Build UI", status: "completed" },
        ],
      }),
    ];

    const result = deriveTaskState([first], second);

    expect(result.history).toHaveLength(0);
    expect(result.current.completedCount).toBe(1);
    expect(result.current.tasks.map((task) => task.description)).toEqual([
      "Run tests",
      "Build UI",
    ]);
  });

  it("keeps completed todos current until a replacement arrives", () => {
    const completed = [
      activity("TodoWrite", {
        todos: [
          { content: "Edit files", status: "completed" },
          { content: "Verify build", status: "completed" },
        ],
      }),
    ];

    const result = deriveTaskState([turn(completed)], []);

    expect(result.history).toHaveLength(0);
    expect(result.current.completedCount).toBe(2);
    expect(result.current.totalCount).toBe(2);
  });

  it("archives the current run when Claude clears todos with an empty list", () => {
    const first = turn([
      activity("TodoWrite", {
        todos: [
          { content: "Implement feature", status: "completed" },
          { content: "Verify feature", status: "completed" },
        ],
      }),
    ]);
    const clear = [
      activity("TodoWrite", {
        todos: [],
      }),
    ];

    const result = deriveTaskState([first], clear);

    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((task) => task.description)).toEqual([
      "Implement feature",
      "Verify feature",
    ]);
    expect(result.current.tasks).toEqual([]);
  });
});

// ── regression: phase-progression workflow ───────────────────
//
// Pins the most common real-world TodoWrite pattern: agent emits a list
// of N tasks, then re-emits the same list multiple times during the
// turn, flipping one task at a time from "pending" → "in_progress" →
// "completed" as work progresses through each phase. The right-sidebar
// Tasks panel should reflect the live count after every update.
//
// Regression target: a #573-era refactor moved TodoWrite handling into
// `deriveTaskStateFromEntries` and split the registry off into
// `parseTodoTasks`; the synthetic IDs assigned to id-less todos (modern
// TodoWrite has no `id` field — only `content` / `status` / `activeForm`)
// must remain stable enough across passes that `todoMap.clear()` plus
// re-set always reflects the LATEST call's statuses, not a stale snapshot.
describe("deriveTaskState — phase progression regression", () => {
  // Build a TodoWrite activity using the modern Claude Code TodoWrite
  // schema (no `id`, no `priority`, content+status+activeForm only).
  const modernTodoWrite = (
    items: Array<{ content: string; status: string; activeForm?: string }>,
  ) =>
    activity("TodoWrite", {
      todos: items.map((it) => ({
        content: it.content,
        status: it.status,
        activeForm: it.activeForm ?? it.content,
      })),
    });

  const PHASES = [
    "Phase 1: Move transport module",
    "Phase 2: Implement RPC handler",
    "Phase 3: Add Tauri command",
    "Phase 4: Workspace member wiring",
    "Phase 5: Plugin integration",
    "Phase 6: Generic send_rpc helper",
    "Phase 7: Load chat history",
    "Phase 8: AskQuestionSheet bottom sheet",
  ];

  it("reflects each phase completion when TodoWrite is re-emitted within a single turn", () => {
    // Three TodoWrite calls in the SAME turn (no finalizeTurn between
    // them), each flipping one phase from pending → completed. This is
    // the screenshot scenario — agent emits the plan once, then re-emits
    // after each commit + push.
    const initial = PHASES.map((p) => ({ content: p, status: "pending" }));
    const afterPhase1 = PHASES.map((p, i) => ({
      content: p,
      status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
    }));
    const afterPhase2 = PHASES.map((p, i) => ({
      content: p,
      status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending",
    }));

    const current = [
      modernTodoWrite(initial),
      modernTodoWrite(afterPhase1),
      modernTodoWrite(afterPhase2),
    ];

    const result = deriveTaskState([], current);

    expect(result.history).toHaveLength(0);
    expect(result.current.totalCount).toBe(8);
    expect(result.current.completedCount).toBe(2);
    // Order must mirror the latest TodoWrite payload, not the first.
    expect(result.current.tasks.map((t) => t.description)).toEqual(PHASES);
    expect(result.current.tasks.map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "in_progress",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("preserves phase completion across a turn boundary", () => {
    // Turn 1: emit the plan with 1 phase completed and persist it as a
    // completed turn. Turn 2 (current): emit another update completing
    // phase 2. The active state should reflect the merged latest view.
    const t1 = turn([
      modernTodoWrite(
        PHASES.map((p, i) => ({
          content: p,
          status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
        })),
      ),
    ]);
    const current = [
      modernTodoWrite(
        PHASES.map((p, i) => ({
          content: p,
          status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending",
        })),
      ),
    ];

    const result = deriveTaskState([t1], current);

    expect(result.history).toHaveLength(0); // status-only update, not archived
    expect(result.current.totalCount).toBe(8);
    expect(result.current.completedCount).toBe(2);
    expect(result.current.tasks[0].status).toBe("completed");
    expect(result.current.tasks[1].status).toBe("completed");
    expect(result.current.tasks[2].status).toBe("in_progress");
  });

  it("does not lose previously-completed phases after a non-TodoWrite tool call between updates", () => {
    // Agent pattern: TodoWrite (mark phase 1 in_progress) → Bash (run
    // commit) → TodoWrite (mark phase 1 completed, phase 2 in_progress).
    // The Bash call must not reset todoMap.
    const inProgress = PHASES.map((p, i) => ({
      content: p,
      status: i === 0 ? "in_progress" : "pending",
    }));
    const completed = PHASES.map((p, i) => ({
      content: p,
      status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
    }));

    const result = deriveTaskState(
      [],
      [
        modernTodoWrite(inProgress),
        activity("Bash", { command: "git commit -am phase-1" }),
        modernTodoWrite(completed),
      ],
    );

    expect(result.current.totalCount).toBe(8);
    expect(result.current.completedCount).toBe(1);
    expect(result.current.tasks[0].status).toBe("completed");
    expect(result.current.tasks[1].status).toBe("in_progress");
  });

  it("treats normalized status strings ('Completed', 'IN_PROGRESS', 'done') as canonical", () => {
    // Defensive: pin that case/punctuation variants from older harnesses
    // (Codex, Pi) still normalize to the canonical TaskStatus values.
    const result = deriveTaskState(
      [],
      [
        modernTodoWrite([
          { content: "A", status: "Completed" },
          { content: "B", status: "IN_PROGRESS" },
          { content: "C", status: "in-progress" },
          { content: "D", status: "done" },
          { content: "E", status: "Running" },
          { content: "F", status: "pending" },
        ]),
      ],
    );

    expect(result.current.completedCount).toBe(2);
    expect(result.current.tasks.map((t) => t.status)).toEqual([
      "completed",
      "in_progress",
      "in_progress",
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("counts completions correctly when the modern TodoWrite schema (no id field) is used", () => {
    // Modern Claude Code TodoWrite has no `id` field — only content,
    // status, activeForm. Earlier versions sent an `id`. The tracker
    // must handle both without losing completion state when only the
    // status field changes between calls.
    const oldSchema = activity("TodoWrite", {
      todos: [
        { id: "a", content: "A", status: "pending" },
        { id: "b", content: "B", status: "pending" },
      ],
    });
    const newSchemaCompleted = modernTodoWrite([
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
    ]);

    const result = deriveTaskState([], [oldSchema, newSchemaCompleted]);

    expect(result.current.totalCount).toBe(2);
    expect(result.current.completedCount).toBe(1);
    // Tasks reflect the LATEST call's order + statuses.
    expect(result.current.tasks.map((t) => t.description)).toEqual(["A", "B"]);
    expect(result.current.tasks[0].status).toBe("completed");
  });
});
