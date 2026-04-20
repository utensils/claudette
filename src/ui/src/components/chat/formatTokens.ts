/** Format a token count for compact display in chat metadata.
 *  Values under 1000 render as raw integers ("999"); values in [1k, 1M)
 *  render as k-compact ("1.2k", "10.0k"); values >= 1M render as M-compact
 *  ("1.0M", "10.0M"). Truncation is always toward zero so we never
 *  over-report usage. */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return `${n}`;
  }
  if (n < 1_000_000) {
    const tenths = Math.trunc(n / 100) / 10;
    return `${tenths.toFixed(1)}k`;
  }
  const tenths = Math.trunc(n / 100_000) / 10;
  return `${tenths.toFixed(1)}M`;
}
