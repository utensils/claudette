import { describe, expect, it } from "vitest";

import {
  REAPED_BACKGROUND_TASK_STATUS,
  isTerminalBackgroundTaskStatus,
} from "./backgroundTaskStatus";

describe("isTerminalBackgroundTaskStatus", () => {
  // The CLI's `task_notification` schema declares a closed enum:
  //   status: z.enum(["completed", "failed", "stopped"])
  // All three have to read as terminal. `"stopped"` is the one that was
  // missing, and it is the value a *terminated* run reports — so killing a
  // workflow left its status pill up for the rest of the session.
  it.each(["completed", "failed", "stopped"])(
    "treats the task_notification status %s as terminal",
    (status) => {
      expect(isTerminalBackgroundTaskStatus(status)).toBe(true);
    },
  );

  // From `task_updated.patch.status`, a channel not consumed yet. Listed so
  // wiring it up later cannot reintroduce the same wedge.
  it("treats killed as terminal", () => {
    expect(isTerminalBackgroundTaskStatus("killed")).toBe(true);
  });

  // Also from `task_updated` — but a paused task has not ended, so it must
  // keep reading as in-flight.
  it.each(["pending", "running", "paused"])(
    "treats the non-terminal status %s as in flight",
    (status) => {
      expect(isTerminalBackgroundTaskStatus(status)).toBe(false);
    },
  );

  it("is case-insensitive", () => {
    expect(isTerminalBackgroundTaskStatus("Stopped")).toBe(true);
    expect(isTerminalBackgroundTaskStatus("COMPLETED")).toBe(true);
  });

  // A workflow checkpointed before its first `task_progress` tick has no
  // status yet and is genuinely still starting. Reading absence as an
  // ending would hide a just-launched run's pill entirely.
  it.each([null, undefined, "", "   "])(
    "does not treat %p as terminal",
    (status) => {
      expect(isTerminalBackgroundTaskStatus(status as string | null)).toBe(
        false,
      );
    },
  );

  it("closes the loop on the status the reaper writes", () => {
    expect(isTerminalBackgroundTaskStatus(REAPED_BACKGROUND_TASK_STATUS)).toBe(
      true,
    );
  });
});
