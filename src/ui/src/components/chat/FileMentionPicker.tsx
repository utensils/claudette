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

export function fuzzyMatchFiles(
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
  const scored: { file: FileEntry; score: number; matchStart: number; matchEnd: number }[] = [];

  for (const file of files) {
    const pathLower = file.path.toLowerCase();
    const filename = pathLower.split("/").pop() ?? pathLower;
    const filenameOffset = file.path.length - filename.length;

    // Priority 1: substring match in filename
    const fnIdx = filename.indexOf(q);
    if (fnIdx >= 0) {
      const score = 100 + (q.length / filename.length) * 50;
      // Boost directories so they sort before files at equal relevance
      const dirBoost = file.is_directory ? 0.5 : 0;
      scored.push({
        file,
        score: score + dirBoost,
        matchStart: filenameOffset + fnIdx,
        matchEnd: filenameOffset + fnIdx + q.length,
      });
      continue;
    }

    // Priority 2: substring match in full path
    const pathIdx = pathLower.indexOf(q);
    if (pathIdx >= 0) {
      const score = 50 + (q.length / pathLower.length) * 25;
      const dirBoost = file.is_directory ? 0.5 : 0;
      scored.push({
        file,
        score: score + dirBoost,
        matchStart: pathIdx,
        matchEnd: pathIdx + q.length,
      });
      continue;
    }

    // No fuzzy fallback — only substring matches
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ file, matchStart, matchEnd }) => ({ file, matchStart, matchEnd }));
}
