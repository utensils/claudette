import { describe, it, expect } from "vitest";
import {
  deriveTasks,
  deriveTaskState,
  extractTaskId,
  finalizeTaskState,
} from "./useTaskTracker";
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

  it("handles basic TaskCreate (subject + description)", () => {
    // Claude Code's TaskCreate emits BOTH `subject` (brief title) and
    // `description` (long body). The tracker uses `subject` for the
    // sidebar label so long descriptions don't blow out the panel.
    const activities = [
      activity(
        "TaskCreate",
        {
          subject: "Implement feature X",
          description: "Long-form details about feature X go here.",
        },
        "Task #1 created successfully: Implement feature X",
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

  it("falls back to description when TaskCreate has no subject", () => {
    const activities = [
      activity(
        "TaskCreate",
        { description: "Implement feature X" },
        '{"task_id": 1}',
      ),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].description).toBe("Implement feature X");
  });

  it("handles TaskCreate → TaskUpdate flow using Claude Code's `taskId` schema", () => {
    // Regression: pre-fix code looked for `input.id`, but the actual
    // TaskUpdate tool input is `{ taskId, status }`. This pins the
    // canonical schema so future refactors don't silently re-break it.
    const activities = [
      activity(
        "TaskCreate",
        { subject: "Write tests" },
        "Task #1 created successfully: Write tests",
      ),
      activity("TaskUpdate", { taskId: "1", status: "in_progress" }),
      activity("TaskUpdate", { taskId: "1", status: "completed" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.tasks[0].status).toBe("completed");
  });

  it("ignores plain `id` on TaskUpdate — accepts only the documented aliases", () => {
    // Tightening the key surface: `id` is a generic JSON key (record id,
    // row id, UUID) and any future tool happening to land a `TaskUpdate`
    // shape with `id` meaning something else would silently bind to the
    // wrong row. Restrict to `taskId` (per Claude Code's documented
    // schema) plus the snake_case / `shell_id` deprecated aliases used
    // by TaskStop.
    const activities = [
      activity(
        "TaskCreate",
        { subject: "Legacy" },
        "Task #5 created successfully: Legacy",
      ),
      activity("TaskUpdate", { id: "5", status: "completed" }),
    ];
    const result = deriveTasks([], activities);
    // The TaskUpdate is treated as an orphan (no recognised id), so the
    // original task is untouched and a stub for "" doesn't get created.
    expect(result.totalCount).toBe(1);
    expect(result.tasks[0].status).toBe("pending");
  });

  it("does not overwrite a TaskCreate's subject with TaskUpdate's long description", () => {
    // Upstream TaskUpdate's `description` field is the long body, not
    // the title. The right-sidebar label was set from `subject` at
    // create time; subsequent body edits must NOT swap it out (the
    // sidebar entry would silently morph from "Implement feature X"
    // into a multi-line essay).
    const activities = [
      activity(
        "TaskCreate",
        {
          subject: "Implement feature X",
          description: "Original short body",
        },
        "Task #3 created successfully: Implement feature X",
      ),
      activity("TaskUpdate", {
        taskId: "3",
        description:
          "Long updated body: the agent expanded its understanding of the task, blah blah blah, multiple paragraphs of new context.",
      }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].description).toBe("Implement feature X");
  });

  it("handles TaskStop with snake_case `task_id`", () => {
    // TaskStop's canonical schema is `{ task_id, shell_id? }`. Pinned
    // separately from TaskUpdate because the two tools intentionally
    // disagree on casing.
    const activities = [
      activity(
        "TaskCreate",
        { subject: "Work" },
        "Task #1 created successfully: Work",
      ),
      activity("TaskStop", { task_id: "1" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].status).toBe("cancelled");
  });

  it("accepts the deprecated `shell_id` key on TaskStop", () => {
    const activities = [
      activity(
        "TaskCreate",
        { subject: "Shell" },
        "Task #2 created successfully: Shell",
      ),
      activity("TaskStop", { shell_id: "2" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.tasks[0].status).toBe("cancelled");
  });

  it('drops a task from the map when TaskUpdate uses status="deleted"', () => {
    // The TaskUpdate tool documents `deleted` as a real status that
    // actually deletes the task server-side; mirror that in the UI
    // rather than rendering it as a stale cancelled entry.
    const activities = [
      activity(
        "TaskCreate",
        { subject: "Throwaway" },
        "Task #7 created successfully: Throwaway",
      ),
      activity("TaskUpdate", { taskId: "7", status: "deleted" }),
    ];
    const result = deriveTasks([], activities);
    expect(result.totalCount).toBe(0);
  });

  it("creates stub for orphaned TaskUpdate", () => {
    const activities = [
      activity("TaskUpdate", { taskId: "99", status: "in_progress" }),
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
      activity(
        "TaskCreate",
        { subject: "Old task" },
        "Task #1 created successfully: Old task",
      ),
    ]);
    const currentActivities = [
      activity("TaskUpdate", { taskId: "1", status: "completed" }),
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
// Regression target: the task-history refactor (PR 773) moved TodoWrite
// handling into `deriveTaskStateFromEntries` and split the registry off
// into `parseTodoTasks`. The synthetic IDs assigned to id-less todos
// (modern TodoWrite has no id field — only content / status / activeForm)
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

// ── deriveTaskState — TaskCreate/TaskUpdate history capture ──
//
// Upstream Claude Code switched away from TodoWrite's "replace whole
// list" pattern to a TaskCreate / TaskUpdate(deleted) pattern: to
// clear the task list, the agent fires a burst of
// `TaskUpdate { taskId, status: "deleted" }` for every existing task
// and then `TaskCreate`s a fresh batch. Our history machinery was only
// wired up for TodoWrite, so the deleted batch silently vanished. The
// blocks below pin the TaskCreate-side equivalent: a burst delete
// followed by new TaskCreates archives the deleted run, mirroring what
// the TodoWrite path already does on replacement.
describe("deriveTaskState — TaskCreate/TaskUpdate history regression", () => {
  // Helper: build the canonical TaskCreate activity Claude Code emits,
  // including the "Task #N created successfully: <subject>" result so
  // `extractTaskId` returns a stable numeric id (matches live data).
  const taskCreate = (id: number, subject: string) =>
    activity(
      "TaskCreate",
      { subject },
      `Task #${id} created successfully: ${subject}`,
    );

  const taskDelete = (id: number) =>
    activity("TaskUpdate", { taskId: String(id), status: "deleted" });

  const taskStatus = (id: number, status: string) =>
    activity("TaskUpdate", { taskId: String(id), status });

  it("archives a burst-deleted task run when a fresh TaskCreate follows", () => {
    // The user's reported scenario: 10 tasks created, all deleted via
    // `TaskUpdate(deleted)`, then 4 fresh tasks created. The 10
    // originals should land in history as a single run; the 4 new
    // tasks should populate `current`.
    const initial = Array.from({ length: 10 }, (_, i) =>
      taskCreate(i + 1, `Original task ${i + 1}`),
    );
    const deletes = Array.from({ length: 10 }, (_, i) => taskDelete(i + 1));
    const fresh = [
      taskCreate(11, "Buff it to a mirror shine."),
      taskCreate(12, "Itemize all hoarded gold."),
      taskCreate(13, "Adjust strings for underwater acoustics."),
      taskCreate(14, "Whatever else"),
    ];

    const result = deriveTaskState([], [...initial, ...deletes, ...fresh]);

    expect(result.history).toHaveLength(1);
    expect(result.history[0].totalCount).toBe(10);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual(
      initial.map((_, i) => `Original task ${i + 1}`),
    );
    expect(result.current.totalCount).toBe(4);
    expect(result.current.tasks.map((t) => t.description)).toEqual([
      "Buff it to a mirror shine.",
      "Itemize all hoarded gold.",
      "Adjust strings for underwater acoustics.",
      "Whatever else",
    ]);
  });

  it("preserves the last-known status of each task when archiving", () => {
    // The history entry should reflect what the task *looked like* at
    // deletion time, not reset everything to pending. Otherwise a list
    // of "all completed" tasks would be archived as "all pending" once
    // it's wiped, losing the user's progress.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskCreate(3, "C"),
        taskStatus(1, "in_progress"),
        taskStatus(1, "completed"),
        taskStatus(2, "completed"),
        taskDelete(1),
        taskDelete(2),
        taskDelete(3),
        taskCreate(4, "Fresh"),
      ],
    );

    expect(result.history).toHaveLength(1);
    const archived = result.history[0].tasks;
    expect(archived.map((t) => t.description)).toEqual(["A", "B", "C"]);
    expect(archived.map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "pending",
    ]);
    expect(result.history[0].completedCount).toBe(2);
    expect(result.history[0].totalCount).toBe(3);
    expect(result.current.tasks.map((t) => t.description)).toEqual(["Fresh"]);
  });

  it("archives a fully-deleted batch at end of stream even without follow-up creates", () => {
    // User stops mid-stream: 3 created, all 3 deleted, no fresh creates.
    // Treat this as a clear (taskMap empty after deletions) and archive
    // the deleted batch so the user can still see what was there.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskCreate(3, "C"),
        taskDelete(1),
        taskDelete(2),
        taskDelete(3),
      ],
    );

    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(result.current.tasks).toEqual([]);
  });

  it("does NOT archive a single mid-stream deletion when other tasks still survive", () => {
    // Refinement pattern: the agent created 5 tasks, decided one was
    // wrong, deleted it, and kept working with the rest. That's not a
    // "clear" — no history entry should appear, just the surviving
    // tasks in current.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskCreate(3, "C"),
        taskCreate(4, "D"),
        taskCreate(5, "E"),
        taskDelete(3),
      ],
    );

    expect(result.history).toHaveLength(0);
    expect(result.current.totalCount).toBe(4);
    expect(result.current.tasks.map((t) => t.description)).toEqual([
      "A",
      "B",
      "D",
      "E",
    ]);
  });

  it("does not archive partial deletions even when a fresh TaskCreate follows", () => {
    // 5 created → 2 deleted (3 remain) → 1 new task. The deletions
    // weren't a clear, so they shouldn't be archived. Only when the
    // entire previous batch is wiped do we treat it as a run boundary.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskCreate(3, "C"),
        taskCreate(4, "D"),
        taskCreate(5, "E"),
        taskDelete(2),
        taskDelete(4),
        taskCreate(6, "F"),
      ],
    );

    expect(result.history).toHaveLength(0);
    expect(result.current.tasks.map((t) => t.description)).toEqual([
      "A",
      "C",
      "E",
      "F",
    ]);
  });

  it("archives TaskStop-only burst closures (subagent pattern) as history", () => {
    // Subagents typically don't fire TaskUpdate(deleted) when they
    // wrap up — they emit TaskStop on each task instead. Treat a
    // TaskStop burst that empties the task list the same as a delete
    // burst for run-boundary purposes: archive into history with the
    // tasks preserved as cancelled.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "Work item A"),
        taskCreate(2, "Work item B"),
        taskStatus(1, "in_progress"),
        taskStatus(1, "completed"),
        activity("TaskStop", { task_id: "1" }),
        activity("TaskStop", { task_id: "2" }),
        taskCreate(3, "Fresh batch"),
      ],
    );

    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Work item A",
      "Work item B",
    ]);
    expect(result.history[0].tasks.map((t) => t.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(result.current.tasks.map((t) => t.description)).toEqual([
      "Fresh batch",
    ]);
  });

  it("archives a mixed burst of delete + TaskStop as one history run", () => {
    // Reviewer-flagged sequence: delete A → TaskStop B → create C
    // should archive both A and B together (A as-status, B cancelled)
    // and start fresh with C. Without this, A would silently vanish
    // because TaskStop'd B still counted as a "live survivor".
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskDelete(1),
        activity("TaskStop", { task_id: "2" }),
        taskCreate(3, "C"),
      ],
    );

    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "A",
      "B",
    ]);
    expect(result.history[0].tasks.map((t) => t.status)).toEqual([
      "pending",
      "cancelled",
    ]);
    expect(result.current.tasks.map((t) => t.description)).toEqual(["C"]);
  });

  it("does NOT archive a single mid-stream TaskStop when other tasks still survive", () => {
    // Refinement pattern with TaskStop: agent stops one task but keeps
    // working with the rest. No history entry should appear.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "A"),
        taskCreate(2, "B"),
        taskCreate(3, "C"),
        activity("TaskStop", { task_id: "2" }),
        taskStatus(1, "completed"),
      ],
    );

    expect(result.history).toHaveLength(0);
    expect(result.current.tasks.map((t) => t.description)).toEqual(["A", "C"]);
    // The stopped task stays out of current (consumed by the deletion
    // buffer) and gets silently dropped — same semantics as a single
    // mid-stream TaskUpdate(deleted) that doesn't trigger archive.
  });

  it("captures multiple delete/recreate cycles as separate history runs", () => {
    // Stress test: three full cycles of "create batch → delete all →
    // create next batch". The right-sidebar should show two completed
    // history runs plus the third batch as current.
    const result = deriveTaskState(
      [],
      [
        taskCreate(1, "Run-1 A"),
        taskCreate(2, "Run-1 B"),
        taskDelete(1),
        taskDelete(2),
        taskCreate(3, "Run-2 A"),
        taskCreate(4, "Run-2 B"),
        taskCreate(5, "Run-2 C"),
        taskDelete(3),
        taskDelete(4),
        taskDelete(5),
        taskCreate(6, "Run-3 A"),
      ],
    );

    expect(result.history).toHaveLength(2);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Run-1 A",
      "Run-1 B",
    ]);
    expect(result.history[1].tasks.map((t) => t.description)).toEqual([
      "Run-2 A",
      "Run-2 B",
      "Run-2 C",
    ]);
    expect(result.current.tasks.map((t) => t.description)).toEqual(["Run-3 A"]);
    // Runs share the global `runSequence` counter with todo runs but
    // must be monotonically increasing within the task path.
    expect(result.history[1].sequence).toBeGreaterThan(
      result.history[0].sequence,
    );
  });

  it("captures a delete burst spanning a turn boundary", () => {
    // Real-world pattern: the agent created and worked on tasks in
    // one turn, then in a later turn cleared them and started fresh.
    // The turn boundary must not break history detection.
    const turn1 = turn([
      taskCreate(1, "Old A"),
      taskCreate(2, "Old B"),
      taskStatus(1, "completed"),
    ]);
    const turn2 = turn([taskDelete(1), taskDelete(2), taskCreate(3, "New A")]);
    const result = deriveTaskState([turn1, turn2], []);

    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Old A",
      "Old B",
    ]);
    expect(result.history[0].tasks[0].status).toBe("completed");
    expect(result.current.tasks.map((t) => t.description)).toEqual(["New A"]);
  });

  it("captures the TodoWrite and TaskCreate history paths independently in the same stream", () => {
    // Belt-and-braces: a mixed session that uses TodoWrite for one
    // phase and TaskCreate for another should produce two distinct
    // history runs without either path stomping on the other.
    const todoFirst = activity("TodoWrite", {
      todos: [
        { content: "todo-1", status: "completed" },
        { content: "todo-2", status: "completed" },
      ],
    });
    const todoReplacement = activity("TodoWrite", {
      todos: [
        { content: "fresh todo X", status: "pending" },
      ],
    });

    const result = deriveTaskState(
      [],
      [
        todoFirst,
        todoReplacement,
        // ↑ TodoWrite replacement → history run #1
        taskCreate(1, "task-1"),
        taskCreate(2, "task-2"),
        taskDelete(1),
        taskDelete(2),
        taskCreate(3, "task-3"),
        // ↑ TaskCreate burst-delete → history run #2
      ],
    );

    expect(result.history).toHaveLength(2);
    // Both runs in history regardless of ordering — pin descriptions.
    const archivedDescriptions = result.history
      .map((run) => run.tasks.map((t) => t.description))
      .flat()
      .sort();
    expect(archivedDescriptions).toEqual(
      ["task-1", "task-2", "todo-1", "todo-2"].sort(),
    );
    // Current shows TaskCreate-sourced entries before TodoWrite-sourced
    // ones — the existing `[...taskMap, ...todoMap]` ordering, pinned
    // so future refactors don't accidentally swap source columns.
    expect(result.current.tasks.map((t) => t.description)).toEqual([
      "task-3",
      "fresh todo X",
    ]);
  });
});

// ── deriveTaskState — subagent task tracking ─────────────────
//
// Claude Code's agent-teams flow spawns subagents that maintain their
// own independent task lists. Their TaskCreate / TaskUpdate calls
// arrive nested inside the parent Agent activity's `agentToolCalls`
// array, with the input field already parsed (vs the top-level
// `inputJson` string) and the TaskCreate response in
// `{ task: { id, subject } }` shape. Live data shape verified against
// the running dev app on 2026-05-15.
//
// The right-sidebar Tasks panel should surface each subagent's
// task list under its `agentDescription` label, independent of the
// main agent's task tracker. Subagent task IDs share the upstream
// "Task #N" numbering space across the whole conversation, so simply
// piping them through the parent taskMap would produce conflicting
// entries (one subagent's #9 vs the main agent's #9). Each subagent
// gets its own bucket.
describe("deriveTaskState — subagent task tracking", () => {
  /** Build an AgentToolCall the way `parseAgentToolCalls` produces them
   *  in `useWorkspaceTaskHistory` — input/response are already-parsed
   *  objects (the JSON deserialization happens upstream). */
  const agentCall = (opts: {
    toolName: string;
    agentId: string;
    input?: unknown;
    response?: unknown;
    status?: "running" | "completed" | "failed";
  }) => ({
    toolUseId: crypto.randomUUID(),
    toolName: opts.toolName,
    agentId: opts.agentId,
    input: opts.input,
    response: opts.response,
    status: opts.status ?? "completed",
    startedAt: "2026-05-15T00:00:00Z",
    completedAt: null,
  });

  /** Build a parent `Agent` activity wrapping a list of subagent calls. */
  const agentActivity = (description: string, calls: ReturnType<typeof agentCall>[]) => {
    const act = activity("Agent", { prompt: description }, "agent done");
    return {
      ...act,
      agentDescription: description,
      agentToolCalls: calls,
    } satisfies ToolActivity;
  };

  it("groups a single subagent's TaskCreate calls under its label", () => {
    // Live data shape: input.subject + response.task.id. Match it
    // exactly so the production code can't drift to a different
    // assumption. Pinned to a running subagent so the run lands in
    // `subagents[]` (completed subagents auto-archive into history;
    // see the dedicated tests below).
    const subagent = {
      ...agentActivity("Agent A: build pagination", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-a",
          input: {
            subject: "Add pagination to /api/sessions",
            description: "Cursor-based, page size 25.",
            activeForm: "Adding pagination",
          },
          response: { task: { id: "9", subject: "Add pagination to /api/sessions" } },
        }),
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-a",
          input: {
            subject: "Fix Opus pricing tier",
            description: "Opus sessions billed at Sonnet rates.",
          },
          response: { task: { id: "11", subject: "Fix Opus pricing tier" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;

    const result = deriveTaskState([], [subagent]);

    expect(result.subagents).toHaveLength(1);
    const run = result.subagents[0];
    expect(run.label).toBe("Agent A: build pagination");
    expect(run.totalCount).toBe(2);
    expect(run.tasks.map((t) => t.description)).toEqual([
      "Add pagination to /api/sessions",
      "Fix Opus pricing tier",
    ]);
    expect(run.tasks.map((t) => t.id)).toEqual(["9", "11"]);
    // Subagent tasks must NOT leak into the main current/history slots.
    expect(result.current.tasks).toEqual([]);
    expect(result.history).toEqual([]);
  });

  it("tracks two subagents under separate labels", () => {
    const agentA = {
      ...agentActivity("Agent A: backend tasks", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-a",
          input: { subject: "A-1" },
          response: { task: { id: "1", subject: "A-1" } },
        }),
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-a",
          input: { subject: "A-2" },
          response: { task: { id: "2", subject: "A-2" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;
    const agentB = {
      ...agentActivity("Agent B: frontend tasks", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-b",
          input: { subject: "B-1" },
          response: { task: { id: "5", subject: "B-1" } },
        }),
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-b",
          input: { subject: "B-2" },
          response: { task: { id: "6", subject: "B-2" } },
        }),
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-b",
          input: { subject: "B-3" },
          response: { task: { id: "7", subject: "B-3" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;

    const result = deriveTaskState([], [agentA, agentB]);

    expect(result.subagents).toHaveLength(2);
    expect(result.subagents.map((r) => r.label)).toEqual([
      "Agent A: backend tasks",
      "Agent B: frontend tasks",
    ]);
    expect(result.subagents[0].tasks.map((t) => t.description)).toEqual([
      "A-1",
      "A-2",
    ]);
    expect(result.subagents[1].tasks.map((t) => t.description)).toEqual([
      "B-1",
      "B-2",
      "B-3",
    ]);
  });

  it("subagent TaskUpdate does not overwrite the original subject with a long description", () => {
    // Same fix as the main-agent path: TaskUpdate.description is the
    // body, not the title. The right-sidebar entry must stay sticky
    // on whatever `subject` the TaskCreate established.
    const subagent = {
      ...agentActivity("Subagent label", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-X",
          input: { subject: "Stable title", description: "Original body" },
          response: { task: { id: "9", subject: "Stable title" } },
        }),
        agentCall({
          toolName: "TaskUpdate",
          agentId: "sub-X",
          input: {
            taskId: "9",
            description:
              "Long updated body with multiple paragraphs that would blow out the sidebar layout if it ever leaked into the title slot.",
          },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;
    const result = deriveTaskState([], [subagent]);
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].tasks[0].description).toBe("Stable title");
  });

  it("applies TaskUpdate status flips to the subagent's own tasks only", () => {
    const subagent = {
      ...agentActivity("Agent C", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-c",
          input: { subject: "Implement feature" },
          response: { task: { id: "1", subject: "Implement feature" } },
        }),
        agentCall({
          toolName: "TaskUpdate",
          agentId: "sub-c",
          input: { taskId: "1", status: "in_progress" },
        }),
        agentCall({
          toolName: "TaskUpdate",
          agentId: "sub-c",
          input: { taskId: "1", status: "completed" },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;

    const result = deriveTaskState([], [subagent]);

    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].tasks[0].status).toBe("completed");
    expect(result.subagents[0].completedCount).toBe(1);
  });

  it("does not collide subagent task IDs with the main agent's tasks", () => {
    // Main agent creates Task #1; subagent also creates Task #1.
    // They live in separate buckets and never overwrite each other.
    const mainCreate = activity(
      "TaskCreate",
      { subject: "Main task" },
      "Task #1 created successfully: Main task",
    );
    const subagent = {
      ...agentActivity("Agent D", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-d",
          input: { subject: "Subagent task" },
          response: { task: { id: "1", subject: "Subagent task" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;

    const result = deriveTaskState([], [mainCreate, subagent]);

    expect(result.current.tasks.map((t) => t.description)).toEqual(["Main task"]);
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].tasks.map((t) => t.description)).toEqual([
      "Subagent task",
    ]);
  });

  it("ignores subagent calls that aren't task-related", () => {
    const subagent = agentActivity("Agent E", [
      agentCall({ toolName: "Bash", agentId: "sub-e", input: { command: "ls" } }),
      agentCall({ toolName: "Read", agentId: "sub-e", input: { file_path: "/tmp/x" } }),
    ]);
    const result = deriveTaskState([], [subagent]);
    // No task tools → no subagent run.
    expect(result.subagents).toEqual([]);
    expect(result.history).toEqual([]);
  });

  it("uses the parent Agent activity's toolUseId as the run's stable key", () => {
    const act = activity("Agent", { prompt: "go" }, "");
    const fixedToolUseId = act.toolUseId;
    const subagent: ToolActivity = {
      ...act,
      agentDescription: "Agent F",
      agentStatus: "running",
      agentToolCalls: [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-f",
          input: { subject: "X" },
          response: { task: { id: "1", subject: "X" } },
        }),
      ],
    };

    const result = deriveTaskState([], [subagent]);
    expect(result.subagents[0].id).toBe(fixedToolUseId);
  });

  it("falls back to a synthetic label when agentDescription is missing", () => {
    const act = activity("Agent", { prompt: "go" }, "");
    const subagent: ToolActivity = {
      ...act,
      // intentionally no agentDescription
      agentStatus: "running",
      agentToolCalls: [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-g",
          input: { subject: "Y" },
          response: { task: { id: "1", subject: "Y" } },
        }),
      ],
    };

    const result = deriveTaskState([], [subagent]);
    expect(result.subagents).toHaveLength(1);
    // Anything non-empty is fine — pin the property so it can't go null.
    expect(result.subagents[0].label).toBeTruthy();
  });

  it("keeps live (running) subagents in subagents[] and archives completed ones to history", () => {
    // Live subagents stay in the current/subagents lane so the user
    // can watch progress in real time. Once their parent activity's
    // status transitions out of "running", treat that as an implicit
    // "close" (the subagent itself rarely calls TaskUpdate(deleted)
    // on its own list before exiting) and graduate the bucket into
    // the history lane.
    const live = {
      ...agentActivity("Running subagent", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-live",
          input: { subject: "Live work" },
          response: { task: { id: "1", subject: "Live work" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;
    const done = {
      ...agentActivity("Finished subagent", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-done",
          input: { subject: "Past work" },
          response: { task: { id: "2", subject: "Past work" } },
        }),
      ]),
      agentStatus: "completed",
    } satisfies ToolActivity;

    const result = deriveTaskState([], [done, live]);

    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].label).toBe("Running subagent");

    expect(result.history).toHaveLength(1);
    expect(result.history[0].label).toBe("Finished subagent");
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Past work",
    ]);
  });

  it("archives failed subagents to history as well", () => {
    // Same rule as completed — "not running" graduates into history.
    // Failures still represent work-that-was-done and the user wants
    // them recorded.
    const failed = {
      ...agentActivity("Crashed subagent", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-fail",
          input: { subject: "Doomed" },
          response: { task: { id: "1", subject: "Doomed" } },
          status: "failed",
        }),
      ]),
      agentStatus: "failed",
    } satisfies ToolActivity;
    const result = deriveTaskState([], [failed]);
    expect(result.subagents).toHaveLength(0);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].label).toBe("Crashed subagent");
  });

  it("treats missing agentStatus as completed and archives the subagent", () => {
    // Historical / DB-reconstructed activities frequently arrive with
    // no `agentStatus` set. We can't keep them suspended in the live
    // subagents lane forever, and treating them as "running" would
    // misrepresent reality. Default to archive.
    const orphan: ToolActivity = {
      ...activity("Agent", { prompt: "go" }, ""),
      agentDescription: "Status-less subagent",
      // agentStatus intentionally omitted
      agentToolCalls: [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-orphan",
          input: { subject: "Z" },
          response: { task: { id: "1", subject: "Z" } },
        }),
      ],
    };

    const result = deriveTaskState([], [orphan]);
    expect(result.subagents).toHaveLength(0);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].label).toBe("Status-less subagent");
  });

  it("dedupes the same Agent toolUseId across past turns and current activities", () => {
    // Defensive: `finalizeTurn` clears `toolActivities[sessionId]` in
    // practice, so an Agent activity normally only appears once. But
    // nothing enforces that contract on the data side — if a future
    // refactor (or a remote-replay path) ever surfaces the same
    // toolUseId in both places, the right-sidebar must not duplicate
    // the subagent section / history run, and React's key contract
    // must hold. Last-write-wins so a transition from running →
    // completed across the two surfaces lands as a single history
    // entry, not a duplicate.
    const act = activity("Agent", { prompt: "go" }, "");
    const stableId = act.toolUseId;

    const past: ToolActivity = {
      ...act,
      agentDescription: "Long-lived subagent",
      agentStatus: "running",
      agentToolCalls: [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-x",
          input: { subject: "Phase 1" },
          response: { task: { id: "1", subject: "Phase 1" } },
        }),
      ],
    };
    // Same toolUseId, status flipped to completed, with one more
    // TaskCreate. This is what a "replayed turn" would look like
    // arriving alongside the still-live current activity.
    const current: ToolActivity = {
      ...past,
      agentStatus: "completed",
      agentToolCalls: [
        ...(past.agentToolCalls ?? []),
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-x",
          input: { subject: "Phase 2" },
          response: { task: { id: "2", subject: "Phase 2" } },
        }),
      ],
    };

    const result = deriveTaskState([turn([past])], [current]);

    // No duplicate React keys, no duplicate bucket. Last write wins.
    expect(result.subagents).toHaveLength(0);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].id).toBe(`subagent-${stableId}`);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Phase 1",
      "Phase 2",
    ]);
  });

  it("collects subagent runs from both completed turns and current activities", () => {
    const subA = {
      ...agentActivity("Past agent", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-past",
          input: { subject: "Past task" },
          response: { task: { id: "1", subject: "Past task" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;
    const subB = {
      ...agentActivity("Live agent", [
        agentCall({
          toolName: "TaskCreate",
          agentId: "sub-live",
          input: { subject: "Live task" },
          response: { task: { id: "2", subject: "Live task" } },
        }),
      ]),
      agentStatus: "running",
    } satisfies ToolActivity;

    const result = deriveTaskState([turn([subA])], [subB]);
    expect(result.subagents).toHaveLength(2);
    expect(result.subagents.map((r) => r.label)).toEqual([
      "Past agent",
      "Live agent",
    ]);
  });
});

// ── finalizeTaskState — closing a session archives its leftovers ──
//
// `useWorkspaceTaskHistory` derives past-session task state but only
// surfaces the resulting `history` runs — anything left in `current`
// (the session ended mid-list) or `subagents` (a subagent was still
// running when the session got closed) silently disappears. When the
// user closes a session tab, those leftovers should land in history
// alongside whatever runs were already there, so the workspace
// keeps a faithful record of past work.
describe("finalizeTaskState", () => {
  it("returns an empty state unchanged", () => {
    const result = finalizeTaskState(deriveTaskState([], []));
    expect(result.current.tasks).toEqual([]);
    expect(result.history).toEqual([]);
    expect(result.subagents).toEqual([]);
  });

  it("graduates leftover current.tasks into history as a final run", () => {
    const todoFirst = activity("TodoWrite", {
      todos: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "completed" },
        { content: "Step 3", status: "pending" },
      ],
    });
    // No replacement TodoWrite arrives — session was closed mid-list.
    const baseline = deriveTaskState([], [todoFirst]);
    expect(baseline.current.totalCount).toBe(3);
    expect(baseline.history).toHaveLength(0);

    const result = finalizeTaskState(baseline);
    expect(result.current.tasks).toEqual([]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Step 1",
      "Step 2",
      "Step 3",
    ]);
    expect(result.history[0].completedCount).toBe(2);
  });

  it("preserves existing history runs and adds the leftovers after them", () => {
    // Session had one TodoWrite replacement (already archived as Run 1)
    // and then a fresh list that never got cleared. Finalizing should
    // produce Run 1 + the leftover, in order.
    const earlier = activity("TodoWrite", {
      todos: [
        { content: "Old A", status: "completed" },
        { content: "Old B", status: "completed" },
      ],
    });
    const replacement = activity("TodoWrite", {
      todos: [{ content: "Different work", status: "in_progress" }],
    });
    const baseline = deriveTaskState([], [earlier, replacement]);
    expect(baseline.history).toHaveLength(1);
    expect(baseline.current.tasks.map((t) => t.description)).toEqual([
      "Different work",
    ]);

    const result = finalizeTaskState(baseline);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Old A",
      "Old B",
    ]);
    expect(result.history[1].tasks.map((t) => t.description)).toEqual([
      "Different work",
    ]);
    expect(result.history[1].sequence).toBeGreaterThan(
      result.history[0].sequence,
    );
  });

  it("archives still-running subagents on finalization with their label", () => {
    // Sub A finished normally → already in baseline.history via
    // status-transition archive. Sub B was still "running" when the
    // session was closed → ends up in baseline.subagents, and
    // finalize should now move it into history with its label.
    const liveSub: ToolActivity = {
      ...activity("Agent", { prompt: "go" }, ""),
      agentDescription: "Still-running subagent",
      agentStatus: "running",
      agentToolCalls: [
        {
          toolUseId: "call-1",
          toolName: "TaskCreate",
          agentId: "sub-live",
          input: { subject: "Incomplete subagent work" },
          response: { task: { id: "1", subject: "Incomplete subagent work" } },
          status: "completed",
          startedAt: "2026-05-15T00:00:00Z",
          completedAt: null,
        },
      ],
    };
    const baseline = deriveTaskState([], [liveSub]);
    expect(baseline.subagents).toHaveLength(1);

    const result = finalizeTaskState(baseline);
    expect(result.subagents).toEqual([]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].label).toBe("Still-running subagent");
    expect(result.history[0].tasks.map((t) => t.description)).toEqual([
      "Incomplete subagent work",
    ]);
  });

  it("clears current and subagents so the finalized state cannot be re-finalized", () => {
    // Defensive: idempotent semantics make it safe to wrap the call
    // anywhere without worrying about double-counting.
    const todoFirst = activity("TodoWrite", {
      todos: [{ content: "Solo", status: "in_progress" }],
    });
    const once = finalizeTaskState(deriveTaskState([], [todoFirst]));
    const twice = finalizeTaskState(once);
    expect(twice.history).toHaveLength(1);
    expect(twice.current.tasks).toEqual([]);
    expect(twice.subagents).toEqual([]);
  });
});
