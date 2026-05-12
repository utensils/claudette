import { describe, expect, it } from "vitest";
import {
  extractMentionPaths,
  isQueuedEditCancelShortcut,
  isQueuedEditSaveShortcut,
  resolveQueuedMentionFiles,
  shouldAutoDispatchQueuedMessage,
} from "./queuedMessageEditing";

describe("queuedMessageEditing", () => {
  it("extracts closed file mentions from prompt text", () => {
    expect([...extractMentionPaths("@src/main.ts and @README.md")]).toEqual([
      "src/main.ts",
      "README.md",
    ]);
    expect([...extractMentionPaths("email@domain.test @src/lib.rs")]).toEqual([
      "src/lib.rs",
    ]);
  });

  it("preserves picker-tracked mentions that still appear in edited content", () => {
    expect(
      resolveQueuedMentionFiles("please read @src/main.ts", [
        "src/main.ts",
        "deleted.ts",
      ]),
    ).toEqual(["src/main.ts"]);
  });

  it("does not auto-dispatch while a queued message is being edited", () => {
    expect(
      shouldAutoDispatchQueuedMessage({
        isSteeringQueued: false,
        isRunning: false,
        activeSessionId: "session-1",
        hasNextQueuedMessage: true,
        isEditingQueuedMessage: true,
        autoDispatchQueuedId: null,
      }),
    ).toBe(false);
  });

  it("auto-dispatches only when idle with a queued message and no edit in progress", () => {
    expect(
      shouldAutoDispatchQueuedMessage({
        isSteeringQueued: false,
        isRunning: false,
        activeSessionId: "session-1",
        hasNextQueuedMessage: true,
        isEditingQueuedMessage: false,
        autoDispatchQueuedId: null,
      }),
    ).toBe(true);
  });

  it("recognizes queued edit save and cancel shortcuts", () => {
    expect(isQueuedEditSaveShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isQueuedEditSaveShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isQueuedEditSaveShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isQueuedEditCancelShortcut({ key: "Escape", metaKey: false, ctrlKey: false })).toBe(true);
  });
});
