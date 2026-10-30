import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "../../services/tauri";
import {
  canResume,
  cycleProgress,
  formatAgo,
  formatCountdown,
  liveSessionId,
  matchesFilter,
  summarize,
  taskStatus,
} from "./schedulerModel";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    chat_session_id: "s1",
    workspace_id: "w1",
    create_new_session: false,
    kind: "cron",
    name: null,
    prompt: "run the tests",
    reason: null,
    fire_at: null,
    cron_expr: "*/5 * * * *",
    recurring: true,
    enabled: true,
    created_at: "2026-10-30T10:00:00Z",
    updated_at: "2026-10-30T10:00:00Z",
    last_fired_at: null,
    next_fire_at: "2026-10-30T10:05:00Z",
    failure_count: 0,
    last_failed_at: null,
    last_error: null,
    disabled_reason: null,
    backend_id: null,
    model: null,
    human_schedule: "Every 5 minutes",
    last_run: null,
    ...overrides,
  };
}

describe("taskStatus", () => {
  it("prefers running over everything", () => {
    expect(taskStatus(makeTask({ enabled: false }), true)).toBe("running");
  });

  it("classifies disabled tasks by reason", () => {
    expect(taskStatus(makeTask({ enabled: false, disabled_reason: "paused" }), false)).toBe(
      "paused",
    );
    expect(
      taskStatus(makeTask({ enabled: false, disabled_reason: "workspace_unavailable" }), false),
    ).toBe("disabled");
    expect(taskStatus(makeTask({ enabled: false }), false)).toBe("done");
  });

  it("flags armed tasks with a failure streak", () => {
    expect(taskStatus(makeTask({ failure_count: 2, last_error: "boom" }), false)).toBe(
      "failing",
    );
    expect(taskStatus(makeTask(), false)).toBe("active");
  });
});

describe("liveSessionId", () => {
  it("uses the last run's session for new-session tasks", () => {
    const run = {
      id: "r1",
      task_id: "t1",
      chat_session_id: "fresh",
      source: "scheduled" as const,
      fired_at: "2026-10-30T10:05:00Z",
      error: null,
    };
    expect(liveSessionId(makeTask({ create_new_session: true, chat_session_id: null }))).toBe(
      null,
    );
    expect(
      liveSessionId(makeTask({ create_new_session: true, chat_session_id: null, last_run: run })),
    ).toBe("fresh");
    expect(liveSessionId(makeTask())).toBe("s1");
  });
});

describe("canResume", () => {
  it("never resumes a fired wakeup", () => {
    expect(canResume(makeTask({ kind: "wakeup", enabled: false }))).toBe(false);
    expect(
      canResume(makeTask({ kind: "wakeup", enabled: false, disabled_reason: "paused" })),
    ).toBe(true);
    expect(canResume(makeTask({ enabled: false }))).toBe(true);
    expect(canResume(makeTask())).toBe(false);
  });
});

describe("cycleProgress", () => {
  it("measures from the previous fire (or creation) to the next", () => {
    const task = makeTask({
      last_fired_at: "2026-10-30T10:00:00Z",
      next_fire_at: "2026-10-30T10:10:00Z",
    });
    expect(cycleProgress(task, Date.parse("2026-10-30T10:05:00Z"))).toBeCloseTo(0.5);
    expect(cycleProgress(task, Date.parse("2026-10-30T11:00:00Z"))).toBe(1);
    expect(cycleProgress(makeTask({ enabled: false }), Date.now())).toBeNull();
  });
});

describe("formatting", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  it("formats countdowns as bare durations", () => {
    expect(formatCountdown("2026-10-30T10:00:30Z", now)).toBe("30s");
    expect(formatCountdown("2026-10-30T12:05:00Z", now)).toBe("2h 5m");
    expect(formatCountdown("2026-10-29T10:00:00Z", now)).toBe("0s");
    expect(formatCountdown(null, now)).toBe("—");
  });

  it("formats elapsed time", () => {
    expect(formatAgo("2026-10-30T09:59:15Z", now)).toBe("45s");
    expect(formatAgo("2026-10-30T07:50:00Z", now)).toBe("2h 10m");
    expect(formatAgo("2026-10-27T10:00:00Z", now)).toBe("3d");
  });
});

describe("summarize", () => {
  it("counts loops, one-shots, running, attention, and the next fire", () => {
    const tasks = [
      makeTask({ id: "loop", next_fire_at: "2026-10-30T11:00:00Z" }),
      makeTask({
        id: "wake",
        kind: "wakeup",
        recurring: false,
        next_fire_at: "2026-10-30T10:30:00Z",
      }),
      makeTask({ id: "paused", enabled: false, disabled_reason: "paused", next_fire_at: null }),
      makeTask({ id: "broken", failure_count: 1, last_error: "x", next_fire_at: null }),
    ];
    const summary = summarize(tasks, (t) => taskStatus(t, t.id === "loop"));
    expect(summary.looping).toBe(2);
    expect(summary.scheduled).toBe(1);
    expect(summary.running).toBe(1);
    expect(summary.attention).toBe(1);
    expect(summary.paused).toBe(1);
    expect(summary.nextUp?.id).toBe("wake");
  });
});

describe("matchesFilter", () => {
  it("filters by status bucket, workspace, and text", () => {
    const task = makeTask({ name: "nightly" });
    expect(matchesFilter(task, "running", "active", "", null)).toBe(true);
    expect(matchesFilter(task, "paused", "active", "", null)).toBe(false);
    expect(matchesFilter(task, "disabled", "attention", "", null)).toBe(true);
    expect(matchesFilter(task, "active", "all", "", "w2")).toBe(false);
    expect(matchesFilter(task, "active", "all", "NIGHT", null)).toBe(true);
    expect(matchesFilter(task, "active", "all", "5 minutes", null)).toBe(true);
    expect(matchesFilter(task, "active", "all", "deploy", null)).toBe(false);
  });
});
