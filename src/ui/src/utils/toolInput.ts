export type ToolInputRecord = Record<string, unknown>;

// Tool rows re-render far more often than their input changes (every
// transcript render, every search keystroke), and several helpers parse the
// same `inputJson` independently per render. A small string-keyed cache turns
// those repeat parses into a map lookup. Bounded FIFO: tool inputs can be
// large (whole-file Writes), so don't keep an unbounded history alive.
const CACHE_LIMIT = 512;
const cache = new Map<string, ToolInputRecord | null>();

/**
 * Parse a tool's `inputJson` into a plain object, or `null` when it is
 * empty, malformed (e.g. still streaming), or not an object (array,
 * scalar, `null`).
 *
 * The returned object is shared across callers via the cache — treat it as
 * read-only.
 */
export function parseToolInput(
  inputJson: string | null | undefined,
): ToolInputRecord | null {
  if (!inputJson) return null;
  const cached = cache.get(inputJson);
  if (cached !== undefined) return cached;

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    // Not cached: a malformed input is almost always a tool_use whose JSON
    // is still streaming, so every chunk is a new, never-repeated key.
    return null;
  }
  const result =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolInputRecord)
      : null;

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(inputJson, result);
  return result;
}

/** A trimmed non-empty string, or `undefined`. */
export function nonEmptyStringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
