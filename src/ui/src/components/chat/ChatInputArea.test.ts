import { describe, expect, it } from "vitest";
import { shouldSteerQueuedTopOnImmediateSend } from "./ChatInputArea";

describe("shouldSteerQueuedTopOnImmediateSend", () => {
  it("uses the top queued message only when the running composer is empty", () => {
    expect(
      shouldSteerQueuedTopOnImmediateSend({
        isRunning: true,
        hasQueuedMessages: true,
        hasComposerPayload: false,
      }),
    ).toBe(true);
  });

  it("keeps immediate send on the composer when text or attachments are present", () => {
    expect(
      shouldSteerQueuedTopOnImmediateSend({
        isRunning: true,
        hasQueuedMessages: true,
        hasComposerPayload: true,
      }),
    ).toBe(false);
  });

  it("does not use queued steering when the agent is idle or the queue is empty", () => {
    expect(
      shouldSteerQueuedTopOnImmediateSend({
        isRunning: false,
        hasQueuedMessages: true,
        hasComposerPayload: false,
      }),
    ).toBe(false);
    expect(
      shouldSteerQueuedTopOnImmediateSend({
        isRunning: true,
        hasQueuedMessages: false,
        hasComposerPayload: false,
      }),
    ).toBe(false);
  });
});
