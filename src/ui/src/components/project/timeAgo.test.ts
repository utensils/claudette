import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { formatTimeAgo } from "./timeAgo";

describe("formatTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for null/undefined/invalid input", () => {
    expect(formatTimeAgo(null)).toBe("");
    expect(formatTimeAgo(undefined)).toBe("");
    expect(formatTimeAgo("not a date")).toBe("");
  });

  it("returns 'now' for very recent timestamps", () => {
    expect(formatTimeAgo("2026-05-19T11:59:30Z")).toBe("now");
  });

  it("formats minutes / hours / days / weeks / months / years", () => {
    expect(formatTimeAgo("2026-05-19T11:55:00Z")).toBe("5m");
    expect(formatTimeAgo("2026-05-19T09:00:00Z")).toBe("3h");
    expect(formatTimeAgo("2026-05-17T12:00:00Z")).toBe("2d");
    expect(formatTimeAgo("2026-05-05T12:00:00Z")).toBe("2w");
    expect(formatTimeAgo("2026-02-19T12:00:00Z")).toBe("3mo");
    expect(formatTimeAgo("2024-05-19T12:00:00Z")).toBe("2y");
  });
});
