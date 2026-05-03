import { diffLines } from "diff";
import type * as monacoNs from "monaco-editor";
import styles from "./MonacoEditor.module.css";

export type LineChangeKind = "add" | "modify" | "delete-above";

export interface LineChange {
  /** 1-based line number in the current buffer. */
  line: number;
  kind: LineChangeKind;
}

/**
 * Classify each line of `buffer` as added/modified/(delete-above) relative
 * to `head`. Pure: same inputs always yield the same output.
 *
 * Algorithm: walk the `diffLines` chunk list once. A `removed` chunk
 * immediately followed by an `added` chunk is a modification — every line
 * of the addition gets marked `modify`. A `removed` chunk with no following
 * addition is a pure deletion — emit a single `delete-above` marker on the
 * line that now sits where the deletion landed (clamped to [1, lastLine]).
 * An `added` chunk not preceded by a `removed` chunk is a pure addition.
 */
export function computeLineChanges(head: string, buffer: string): LineChange[] {
  const chunks = diffLines(head, buffer);
  const changes: LineChange[] = [];

  // Track the 1-based line number in the *buffer* as we walk chunks. Lines
  // covered by `removed` chunks don't advance the buffer cursor; `added`
  // and unchanged chunks do.
  let bufferLine = 1;
  // Total line count of the buffer — used to clamp end-of-file deletes.
  const bufferLineCount = countLines(buffer);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const lines = chunk.count ?? countLines(chunk.value);

    if (chunk.removed) {
      const next = chunks[i + 1];
      if (next && next.added) {
        // Modification: emit one `modify` per line of the addition.
        const addLines = next.count ?? countLines(next.value);
        for (let k = 0; k < addLines; k++) {
          changes.push({ line: bufferLine + k, kind: "modify" });
        }
        bufferLine += addLines;
        // Skip the addition we just consumed.
        i++;
      } else {
        // Pure deletion: marker on the line that now occupies the deleted
        // chunk's position. Clamp to [1, bufferLineCount]; clamp to 1 when
        // the buffer is empty (no surviving line).
        const target =
          bufferLineCount === 0 ? 1 : Math.min(Math.max(bufferLine, 1), bufferLineCount);
        // Avoid duplicate markers if multiple removed chunks fall on the
        // same line.
        const last = changes[changes.length - 1];
        if (!last || last.line !== target || last.kind !== "delete-above") {
          changes.push({ line: target, kind: "delete-above" });
        }
      }
      // `removed` chunks don't advance the buffer cursor.
      continue;
    }

    if (chunk.added) {
      for (let k = 0; k < lines; k++) {
        changes.push({ line: bufferLine + k, kind: "add" });
      }
      bufferLine += lines;
      continue;
    }

    // Unchanged.
    bufferLine += lines;
  }

  return changes;
}

function countLines(s: string): number {
  if (s === "") return 0;
  const parts = s.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/**
 * Convert structured line-change data into Monaco decoration deltas. Each
 * change becomes a 0-column, 1-line range with a `linesDecorationsClassName`
 * pointing at our CSS-module class for the appropriate kind.
 *
 * `NeverGrowsWhenTypingAtEdges` stickiness keeps a marker pinned to its
 * line — without it, an insertion at the start of the line would pull the
 * marker onto the next line.
 */
export function lineChangesToDecorations(
  changes: LineChange[],
  monacoInstance: typeof monacoNs,
): monacoNs.editor.IModelDeltaDecoration[] {
  return changes.map((change) => ({
    range: new monacoInstance.Range(change.line, 1, change.line, 1),
    options: {
      linesDecorationsClassName: classFor(change.kind),
      stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
}

function classFor(kind: LineChangeKind): string {
  switch (kind) {
    case "add":
      return styles.gitGutterAdd;
    case "modify":
      return styles.gitGutterModify;
    case "delete-above":
      return styles.gitGutterDeleteAbove;
  }
}
