import type { FileDiff } from "../../types";

export function oldSideTextFromDiff(diff: FileDiff | null): string | null {
  if (!diff || diff.is_binary) return null;
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.old_line_number !== null) {
        lines.push(line.content);
      }
    }
  }
  if (lines.length === 0) return null;
  return `${lines.join("\n")}\n`;
}
