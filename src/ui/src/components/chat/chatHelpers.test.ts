import { describe, expect, it } from "vitest";
import { formatDurationMs, formatElapsedSeconds } from "./chatHelpers";

describe("formatElapsedSeconds", () => {
  it("formats sub-minute durations as seconds only", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(15)).toBe("15s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 0s");
    expect(formatElapsedSeconds(154)).toBe("2m 34s");
    expect(formatElapsedSeconds(3599)).toBe("59m 59s");
  });

  it("formats sub-day durations as hours, minutes, and seconds", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h 0m 0s");
    // 1369m 33s, the long-running example this format was extended for
    expect(formatElapsedSeconds(82173)).toBe("22h 49m 33s");
    expect(formatElapsedSeconds(86399)).toBe("23h 59m 59s");
  });

  it("formats multi-day durations as days, hours, minutes, and seconds", () => {
    expect(formatElapsedSeconds(86400)).toBe("1d 0h 0m 0s");
    expect(formatElapsedSeconds(90061)).toBe("1d 1h 1m 1s");
    expect(formatElapsedSeconds(200000)).toBe("2d 7h 33m 20s");
  });
});

describe("formatDurationMs", () => {
  it("delegates to formatElapsedSeconds, rounding sub-second durations up to 1s", () => {
    expect(formatDurationMs(400)).toBe("1s");
    expect(formatDurationMs(2500)).toBe("2s");
    expect(formatDurationMs(82_173_000)).toBe("22h 49m 33s");
  });
});
