export function parseChatTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const normalized = normalizeSqliteTimestamp(value);
  return Date.parse(normalized);
}

function normalizeSqliteTimestamp(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
    return `${trimmed.replace(" ", "T")}Z`;
  }
  return trimmed;
}
