/** Compact human formatting for dashboard-mode metric tiles. */

/** `1234ms` → `1.2s`, `83000ms` → `1m 23s`. Empty string for undefined. */
export function formatDashboardDuration(ms: number | undefined): string {
  if (ms == null || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/** `1234` → `1.2K`, `2_500_000` → `2.5M`. Empty string for undefined/zero. */
export function formatDashboardTokens(n: number | undefined): string {
  if (n == null || n <= 0) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
