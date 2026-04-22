export function estimateCost(totalTokens: number): number {
  return (totalTokens / 1_000_000) * 15;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}
