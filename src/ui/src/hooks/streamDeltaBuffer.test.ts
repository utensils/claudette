import { describe, expect, it, vi } from "vitest";
import { StreamDeltaBuffer, type StreamDeltaSink } from "./streamDeltaBuffer";

function setup() {
  const calls: string[] = [];
  const sink: StreamDeltaSink = {
    appendText: (s, t) => calls.push(`text:${s}:${t}`),
    appendThinking: (s, t) => calls.push(`thinking:${s}:${t}`),
    appendToolInput: (s, id, j) => calls.push(`tool:${s}:${id}:${j}`),
  };
  let pending: (() => void) | null = null;
  const schedule = vi.fn((flush: () => void) => {
    pending = flush;
  });
  const buffer = new StreamDeltaBuffer(sink, schedule);
  return { buffer, calls, schedule, runScheduled: () => pending?.() };
}

describe("StreamDeltaBuffer", () => {
  it("coalesces deltas into one write per session/tool per frame", () => {
    const { buffer, calls, schedule, runScheduled } = setup();
    buffer.appendText("s1", "Hel");
    buffer.appendText("s1", "lo");
    buffer.appendToolInput("s1", "t1", '{"a":');
    buffer.appendToolInput("s1", "t1", "1}");
    buffer.appendThinking("s2", "hmm");
    expect(calls).toEqual([]);
    expect(schedule).toHaveBeenCalledTimes(1);

    runScheduled();
    expect(calls).toEqual([
      "thinking:s2:hmm",
      "text:s1:Hello",
      'tool:s1:t1:{"a":1}',
    ]);
  });

  it("flushes synchronously on demand and stays empty afterwards", () => {
    const { buffer, calls, runScheduled } = setup();
    buffer.appendText("s1", "x");
    buffer.flush();
    expect(calls).toEqual(["text:s1:x"]);
    // The already-scheduled frame callback must not re-apply anything.
    runScheduled();
    buffer.flush();
    expect(calls).toEqual(["text:s1:x"]);
  });

  it("schedules a new frame after a flush", () => {
    const { buffer, schedule } = setup();
    buffer.appendText("s1", "a");
    buffer.flush();
    buffer.appendText("s1", "b");
    expect(schedule).toHaveBeenCalledTimes(2);
  });
});
