/**
 * Score a command against a search query for relevance ranking.
 * Higher scores indicate better matches.
 */
export function scoreCommand(
  name: string,
  description: string | undefined,
  keywords: string[] | undefined,
  query: string,
): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  const desc = description?.toLowerCase() ?? "";

  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  if (desc.includes(q)) return 20;
  if (keywords?.some((k) => k.toLowerCase().includes(q))) return 10;
  return 0;
}
