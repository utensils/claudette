/**
 * Shared parser/formatter for Anthropic usage `resets_at` values.
 *
 * The usage API returns reset times as either an ISO string or an epoch
 * timestamp (seconds OR milliseconds, depending on the bucket). Both the
 * Settings panel and the composer indicator render countdowns from this
 * value but want slightly different copy ("resets in 1h 23m" vs. "1h 23m"),
 * so we share the parse and let callers wrap.
 */

export interface ResetCountdown {
  /** True once the reset moment has passed (utilization should refresh). */
  resetting: boolean;
  /** Whole days remaining (only > 0 when total >= 24h). */
  days: number;
  /** Hours remaining within the current day (0-23). */
  hours: number;
  /** Minutes remaining within the current hour (0-59). */
  minutes: number;
}

function parseResetMs(resetsAt: string | number): number {
  if (typeof resetsAt === "string") return new Date(resetsAt).getTime();
  // API returns seconds for some buckets, milliseconds for others.
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

export function resetCountdown(
  resetsAt: string | number,
  now: number = Date.now(),
): ResetCountdown {
  const diffSec = (parseResetMs(resetsAt) - now) / 1000;
  if (diffSec <= 0) {
    return { resetting: true, days: 0, hours: 0, minutes: 0 };
  }
  const totalHours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const days = Math.floor(totalHours / 24);
  const hours = days > 0 ? totalHours % 24 : totalHours;
  return { resetting: false, days, hours, minutes };
}

/** Compact countdown ("1h 23m" / "2d 5h" / "resetting…"). */
export function formatResetCountdown(resetsAt: string | number): string {
  const c = resetCountdown(resetsAt);
  if (c.resetting) return "resetting…";
  if (c.days > 0) return `${c.days}d ${c.hours}h`;
  if (c.hours > 0) return `${c.hours}h ${c.minutes}m`;
  return `${c.minutes}m`;
}

/** Settings-style "resets in X" copy ("resets in 1h 23m" / "resetting now"). */
export function formatResetIn(resetsAt: string | number): string {
  const c = resetCountdown(resetsAt);
  if (c.resetting) return "resetting now";
  if (c.days > 0) return `resets in ${c.days}d ${c.hours}h`;
  if (c.hours > 0) return `resets in ${c.hours}h ${c.minutes}m`;
  return `resets in ${c.minutes}m`;
}
