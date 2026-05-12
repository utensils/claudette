import { describe, expect, it } from "vitest";
import {
  bufferEarlyPtyOutput,
  flushEarlyPtyOutput,
  type EarlyPtyOutputBuffer,
} from "./terminalPtyOutputBuffer";

describe("terminalPtyOutputBuffer", () => {
  it("flushes only the chunks for the claimed PTY id", () => {
    const buffer: EarlyPtyOutputBuffer = new Map();
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [65] });
    bufferEarlyPtyOutput(buffer, { pty_id: 2, data: [66] });
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [67] });

    const flushed: number[][] = [];
    flushEarlyPtyOutput(buffer, 1, (data) => flushed.push(data));

    expect(flushed).toEqual([[65], [67]]);
    expect(buffer.has(1)).toBe(false);
    expect(buffer.get(2)?.chunks).toEqual([[66]]);
  });

  it("keeps the newest chunks when the byte limit is exceeded", () => {
    const buffer: EarlyPtyOutputBuffer = new Map();
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [1, 2] }, 4);
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [3, 4] }, 4);
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [5] }, 4);

    const flushed: number[][] = [];
    flushEarlyPtyOutput(buffer, 1, (data) => flushed.push(data));

    expect(flushed).toEqual([[3, 4], [5]]);
  });

  it("trims without shifting stored chunks on every eviction", () => {
    const buffer: EarlyPtyOutputBuffer = new Map();
    for (let i = 0; i < 40; i += 1) {
      bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [i] }, 40);
    }
    bufferEarlyPtyOutput(buffer, { pty_id: 1, data: [40] }, 40);

    const flushed: number[][] = [];
    flushEarlyPtyOutput(buffer, 1, (data) => flushed.push(data));

    expect(flushed).toHaveLength(40);
    expect(flushed[0]).toEqual([1]);
    expect(flushed.at(-1)).toEqual([40]);
  });
});
