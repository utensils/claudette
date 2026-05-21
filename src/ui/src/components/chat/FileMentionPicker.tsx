import type { FileEntry } from "../../services/tauri";
import styles from "./FileMentionPicker.module.css";

const MAX_RESULTS = 50;

export interface FileMatchResult {
  file: FileEntry;
  matchStart: number;
  matchEnd: number;
}

interface FileMentionPickerProps {
  results: FileMatchResult[];
  selectedIndex: number;
  onSelect: (file: FileEntry) => void;
  onHover: (index: number) => void;
}

interface ScoredFileMatch extends FileMatchResult {
  score: number;
}

interface SubsequenceMatch {
  score: number;
  matchStart: number;
  matchEnd: number;
}

export function FileMentionPicker({
  results,
  selectedIndex,
  onSelect,
  onHover,
}: FileMentionPickerProps) {
  if (results.length === 0) return null;

  return (
    <div className={styles.picker} role="listbox">
      {results.map(({ file, matchStart, matchEnd }, i) => {
        const pre = file.path.slice(0, matchStart);
        const matched = file.path.slice(matchStart, matchEnd);
        const post = file.path.slice(matchEnd);

        return (
          <div
            key={file.path}
            role="option"
            aria-selected={i === selectedIndex}
            className={`${styles.item} ${i === selectedIndex ? styles.itemSelected : ""}`}
            onClick={() => onSelect(file)}
            onMouseEnter={() => onHover(i)}
          >
            <span className={styles.atSign}>@</span>
            <span className={styles.pathText}>
              {pre}
              <span className={styles.highlight}>{matched}</span>
              {post}
            </span>
            {file.is_directory && <span className={styles.dirBadge}>dir</span>}
          </div>
        );
      })}
    </div>
  );
}

export function matchFiles(
  files: FileEntry[],
  query: string,
): FileMatchResult[] {
  if (!query) {
    return files.slice(0, MAX_RESULTS).map((file) => ({
      file,
      matchStart: 0,
      matchEnd: 0,
    }));
  }

  const q = query.toLowerCase();
  const scored: ScoredFileMatch[] = [];

  for (const file of files) {
    const pathLower = file.path.toLowerCase();
    const filename = pathLower.split("/").pop() ?? pathLower;
    const filenameOffset = file.path.length - filename.length;

    // Priority 1: substring match in filename
    const fnIdx = filename.indexOf(q);
    if (fnIdx >= 0) {
      const score = 100 + (q.length / filename.length) * 50;
      scored.push({
        file,
        score: score + directoryBoost(file),
        matchStart: filenameOffset + fnIdx,
        matchEnd: filenameOffset + fnIdx + q.length,
      });
      continue;
    }

    // Priority 2: substring match in full path
    const pathIdx = pathLower.indexOf(q);
    if (pathIdx >= 0) {
      const score = 50 + (q.length / pathLower.length) * 25;
      scored.push({
        file,
        score: score + directoryBoost(file),
        matchStart: pathIdx,
        matchEnd: pathIdx + q.length,
      });
      continue;
    }

    const filenameMatch = scoreSubsequence(
      file.path.slice(filenameOffset),
      q,
    );
    if (filenameMatch) {
      const matchPosition = filenameOffset + filenameMatch.matchStart;
      scored.push({
        file,
        score: 20 + filenameMatch.score + directoryBoost(file),
        matchStart: matchPosition,
        matchEnd: matchPosition,
      });
      continue;
    }

    const pathMatch = scoreSubsequence(file.path, q);
    if (pathMatch) {
      scored.push({
        file,
        score: 5 + pathMatch.score + directoryBoost(file),
        matchStart: pathMatch.matchStart,
        matchEnd: pathMatch.matchStart,
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ file, matchStart, matchEnd }) => ({ file, matchStart, matchEnd }));
}

function directoryBoost(file: FileEntry): number {
  return file.is_directory ? 0.5 : 0;
}

function scoreSubsequence(
  target: string,
  queryLower: string,
): SubsequenceMatch | null {
  if (queryLower.length > target.length) {
    return null;
  }

  const targetLower = target.toLowerCase();
  const positions: number[] = [];
  let queryIndex = 0;

  for (
    let i = 0;
    i < targetLower.length && queryIndex < queryLower.length;
    i += 1
  ) {
    if (targetLower[i] === queryLower[queryIndex]) {
      positions.push(i);
      queryIndex += 1;
    }
  }

  if (queryIndex !== queryLower.length || positions.length === 0) {
    return null;
  }

  const matchStart = positions[0] ?? 0;
  const lastPosition = positions[positions.length - 1] ?? matchStart;
  const matchEnd = lastPosition + 1;
  const spanLength = matchEnd - matchStart;
  const density = queryLower.length / spanLength;
  const boundaryHits = positions.filter((position) =>
    isWordBoundary(target, position),
  ).length;
  const boundaryRatio = boundaryHits / positions.length;
  const contiguousPairs = positions.slice(1).filter((position, index) => {
    return position === positions[index] + 1;
  }).length;
  const contiguityRatio =
    positions.length > 1 ? contiguousPairs / (positions.length - 1) : 1;
  const startRatio =
    target.length > 0 ? 1 - matchStart / Math.max(target.length, 1) : 1;

  return {
    score:
      density * 10 +
      contiguityRatio * 8 +
      boundaryRatio * 6 +
      startRatio * 3,
    matchStart,
    matchEnd,
  };
}

function isWordBoundary(target: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = target[index - 1] ?? "";
  const current = target[index] ?? "";

  return (
    previous === "/" ||
    previous === "-" ||
    previous === "_" ||
    previous === "." ||
    previous === " " ||
    (isLowercaseAscii(previous) && isUppercaseAscii(current))
  );
}

function isLowercaseAscii(value: string): boolean {
  return value >= "a" && value <= "z";
}

function isUppercaseAscii(value: string): boolean {
  return value >= "A" && value <= "Z";
}
