import type { FileEntry } from "./commands";

export interface PreparedFileSearchEntry {
  path: string;
  basename: string;
  dirname: string;
  lowerPath: string;
  lowerBasename: string;
  pathBoundaries: Uint8Array;
  basenameStart: number;
}

export interface FileSearchResult {
  entry: PreparedFileSearchEntry;
  score: number;
  basenameMatches: number[];
  pathMatches: number[];
}

interface SegmentScore {
  score: number;
  matches: number[];
}

const SCORE_EXACT = 12_000;
const SCORE_PREFIX = 4_000;
const SCORE_SUBSEQUENCE = 1_000;
const SCORE_CONSECUTIVE = 70;
const SCORE_BOUNDARY = 90;
const SCORE_SEPARATOR = 45;
const SCORE_CAMEL = 35;
const SCORE_EARLY = 2;
const SCORE_GAP_PENALTY = 18;
const SCORE_PATH_BASENAME_RANGE = 550;

export const DEFAULT_FILE_SEARCH_LIMIT = 200;

export function prepareFileSearchIndex(files: FileEntry[]): PreparedFileSearchEntry[] {
  return files
    .filter((file) => !file.is_directory)
    .map((file) => {
      const basenameStart = file.path.lastIndexOf("/") + 1;
      const basename = file.path.slice(basenameStart);
      return {
        path: file.path,
        basename,
        dirname: basenameStart > 0 ? file.path.slice(0, basenameStart - 1) : "",
        lowerPath: file.path.toLowerCase(),
        lowerBasename: basename.toLowerCase(),
        pathBoundaries: computeBoundaries(file.path),
        basenameStart,
      };
    });
}

export function searchFileIndex(
  index: readonly PreparedFileSearchEntry[],
  query: string,
  limit = DEFAULT_FILE_SEARCH_LIMIT,
): FileSearchResult[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return index.slice(0, limit).map((entry, order) => ({
      entry,
      score: -order,
      basenameMatches: [],
      pathMatches: [],
    }));
  }

  const results: FileSearchResult[] = [];
  for (const entry of index) {
    const basenameScore = scoreSegment(
      entry.lowerBasename,
      entry.pathBoundaries,
      normalizedQuery,
      entry.basenameStart,
    );
    const pathScore = scoreSegment(
      entry.lowerPath,
      entry.pathBoundaries,
      normalizedQuery,
      0,
    );
    if (!basenameScore && !pathScore) continue;

    const basenameBoost = basenameScore
      ? SCORE_PATH_BASENAME_RANGE + basenameScore.score * 1.8
      : 0;
    const pathBoost = pathScore ? pathScore.score : 0;
    const score = basenameBoost + pathBoost - entry.path.length * 0.6;
    results.push({
      entry,
      score,
      basenameMatches: basenameScore?.matches ?? [],
      pathMatches: pathScore?.matches ?? [],
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.path.localeCompare(b.entry.path);
  });
  return results.slice(0, limit);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSegment(
  target: string,
  boundaries: Uint8Array,
  query: string,
  boundaryOffset: number,
): SegmentScore | null {
  if (query.length === 0) return { score: 0, matches: [] };
  const matches = fuzzyMatch(target, query);
  if (!matches) return null;

  const exact = target === query ? SCORE_EXACT : 0;
  const prefix = matches[0] === 0 ? SCORE_PREFIX : 0;
  let score = SCORE_SUBSEQUENCE + exact + prefix;
  let previous = -1;
  for (let i = 0; i < matches.length; i += 1) {
    const index = matches[i];
    const boundary = boundaries[index + boundaryOffset] ?? 0;
    if (boundary > 0) score += SCORE_BOUNDARY;
    if (boundary === 2) score += SCORE_SEPARATOR;
    if (boundary === 3) score += SCORE_CAMEL;
    if (previous >= 0) {
      const gap = index - previous - 1;
      if (gap === 0) {
        score += SCORE_CONSECUTIVE;
      } else {
        score -= Math.min(280, gap * SCORE_GAP_PENALTY);
      }
    }
    previous = index;
  }
  score -= matches[0] * SCORE_EARLY;
  return { score, matches };
}

function fuzzyMatch(target: string, query: string): number[] | null {
  const matches: number[] = [];
  let searchFrom = 0;
  for (const char of query) {
    const index = target.indexOf(char, searchFrom);
    if (index === -1) return null;
    matches.push(index);
    searchFrom = index + 1;
  }
  return matches;
}

function computeBoundaries(value: string): Uint8Array {
  const boundaries = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const prev = index > 0 ? value[index - 1] : "";
    if (index === 0) {
      boundaries[index] = 2;
    } else if (prev === "/" || prev === "-" || prev === "_" || prev === "." || prev === " ") {
      boundaries[index] = 2;
    } else if (isLower(prev) && isUpper(char)) {
      boundaries[index] = 3;
    }
  }
  return boundaries;
}

function isLower(char: string): boolean {
  return char >= "a" && char <= "z";
}

function isUpper(char: string): boolean {
  return char >= "A" && char <= "Z";
}
