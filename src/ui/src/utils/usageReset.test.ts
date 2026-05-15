import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatResetCountdown,
  formatResetIn,
  resetCountdown,
} from "./usageReset";

const NOW = Date.parse("2026-05-14T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resetCountdown", () => {
  it("parses ISO strings", () => {
    const c = resetCountdown("2026-05-14T13:30:00Z");
    expect(c).toEqual({ resetting: false, days: 0, hours: 1, minutes: 30 });
  });

  it("parses epoch seconds", () => {
    const sec = Math.floor((NOW + 90 * 60_000) / 1000);
    const c = resetCountdown(sec);
    expect(c).toEqual({ resetting: false, days: 0, hours: 1, minutes: 30 });
  });

  it("parses epoch milliseconds", () => {
    const c = resetCountdown(NOW + 5 * 60_000);
    expect(c).toEqual({ resetting: false, days: 0, hours: 0, minutes: 5 });
  });

  it("flags resetting when the timestamp is in the past", () => {
    const c = resetCountdown(NOW - 1000);
    expect(c.resetting).toBe(true);
  });

  it("rolls over into days at >= 24h", () => {
    const c = resetCountdown(NOW + (2 * 24 + 5) * 3600 * 1000);
    expect(c).toEqual({ resetting: false, days: 2, hours: 5, minutes: 0 });
  });
});

describe("formatResetCountdown", () => {
  it("shows minutes only when under an hour", () => {
    expect(formatResetCountdown(NOW + 30 * 60_000)).toBe("30m");
  });

  it("shows hours and minutes within a day", () => {
    expect(formatResetCountdown(NOW + (3 * 60 + 15) * 60_000)).toBe("3h 15m");
  });

  it("shows days and hours past a day", () => {
    expect(formatResetCountdown(NOW + (25 * 60 + 0) * 60_000)).toBe("1d 1h");
  });

  it("returns resetting placeholder when in the past", () => {
    expect(formatResetCountdown(NOW - 1000)).toBe("resetting…");
  });
});

describe("formatResetIn", () => {
  it("prefixes with 'resets in'", () => {
    expect(formatResetIn(NOW + 90 * 60_000)).toBe("resets in 1h 30m");
  });

  it("returns 'resetting now' in the past", () => {
    expect(formatResetIn(NOW - 1000)).toBe("resetting now");
  });
});
