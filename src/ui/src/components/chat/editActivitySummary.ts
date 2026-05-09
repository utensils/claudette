import type { AgentToolCall, ToolActivity } from "../../stores/useAppStore";
import type { DiffFile, FileDiff } from "../../types/diff";

export interface EditFileStat {
  filePath: string;
  added: number;
  removed: number;
  previewLines: EditPreviewLine[];
}

export interface EditSummary {
  files: EditFileStat[];
  added: number;
  removed: number;
}

export type EditPreviewLineType = "added" | "removed" | "context" | "hunk";

export interface EditPreviewLine {
  type: EditPreviewLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

type JsonRecord = Record<string, unknown>;

const MAX_PREVIEW_LINES_PER_FILE = 80;

export function summarizeToolActivityEdit(
  activity: ToolActivity,
): EditSummary | null {
  return summarizeEditToolInput(activity.toolName, parseJsonRecord(activity.inputJson));
}

export function summarizeAgentToolCallEdit(
  call: AgentToolCall,
): EditSummary | null {
  return summarizeEditToolInput(call.toolName, recordFromUnknown(call.input));
}

export function summarizeTurnEdits(
  activities: readonly ToolActivity[],
): EditSummary | null {
  const stats: EditFileStat[] = [];
  for (const activity of activities) {
    const direct = summarizeToolActivityEdit(activity);
    if (direct) stats.push(...direct.files);
    for (const call of activity.agentToolCalls ?? []) {
      const nested = summarizeAgentToolCallEdit(call);
      if (nested) stats.push(...nested.files);
    }
  }
  return mergeStats(stats);
}

export function summarizeDiffFiles(files: readonly DiffFile[]): EditSummary | null {
  return mergeStats(
    files.map((file) => ({
      filePath: file.path,
      added: file.additions ?? 0,
      removed: file.deletions ?? 0,
      previewLines: [],
    })),
  );
}

export function previewLinesFromFileDiff(diff: FileDiff): EditPreviewLine[] {
  const lines: EditPreviewLine[] = [];
  diff.hunks.forEach((hunk, idx) => {
    if (lines.length >= MAX_PREVIEW_LINES_PER_FILE) return;
    // Separator between hunks (skip before the first one) so a file
    // edited in distant regions visually breaks into chunks instead
    // of running as one long block. The header carries the
    // `@@ -OLD,N +NEW,M @@` text the backend already produced.
    if (idx > 0) {
      lines.push({
        type: "hunk",
        oldLineNumber: null,
        newLineNumber: null,
        content: hunk.header,
      });
    }
    for (const line of hunk.lines) {
      if (lines.length >= MAX_PREVIEW_LINES_PER_FILE) return;
      lines.push({
        type:
          line.line_type === "Added"
            ? "added"
            : line.line_type === "Removed"
              ? "removed"
              : "context",
        oldLineNumber: line.old_line_number,
        newLineNumber: line.new_line_number,
        content: line.content,
      });
    }
  });
  return lines;
}

function summarizeEditToolInput(
  toolName: string,
  input: JsonRecord | null,
): EditSummary | null {
  if (!input) return null;
  const normalized = toolName.toLowerCase();

  if (normalized === "edit") {
    return statFromReplacement(
      stringField(input, "file_path"),
      stringField(input, "old_string"),
      stringField(input, "new_string"),
    );
  }

  if (normalized === "multiedit") {
    const filePath = stringField(input, "file_path");
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const stats = edits
      .map((edit) =>
        statFromReplacement(
          filePath,
          stringField(recordFromUnknown(edit), "old_string"),
          stringField(recordFromUnknown(edit), "new_string"),
        ),
      )
      .flatMap((summary) => summary?.files ?? []);
    return mergeStats(stats);
  }

  if (normalized === "write") {
    const filePath = stringField(input, "file_path");
    const content = stringField(input, "content");
    if (!filePath || content === null) return null;
    return mergeStats([
      {
        filePath,
        added: changedLineCount(content),
        removed: 0,
        previewLines: linesFromText(content, "added"),
      },
    ]);
  }

  if (normalized === "notebookedit") {
    return statFromReplacement(
      stringField(input, "notebook_path"),
      stringField(input, "old_source") ?? stringField(input, "source"),
      stringField(input, "new_source"),
    );
  }

  if (normalized.includes("str_replace")) {
    return statFromReplacement(
      stringField(input, "path") ?? stringField(input, "file_path"),
      stringField(input, "old_str") ?? stringField(input, "old_string"),
      stringField(input, "new_str") ?? stringField(input, "new_string"),
    );
  }

  if (normalized.includes("apply_patch") || normalized.includes("patch")) {
    const patch = patchTextFromInput(input);
    return patch ? mergeStats(parsePatchStats(patch)) : null;
  }

  const patch = patchTextFromInput(input);
  return patch ? mergeStats(parsePatchStats(patch)) : null;
}

function patchTextFromInput(input: JsonRecord): string | null {
  for (const field of ["patch", "input", "cmd", "command"] as const) {
    const value = stringField(input, field);
    if (value && looksLikePatch(value)) return value;
  }
  return null;
}

function looksLikePatch(value: string): boolean {
  return value.includes("*** Begin Patch") || value.includes("diff --git ");
}

function statFromReplacement(
  filePath: string | null,
  oldText: string | null,
  newText: string | null,
): EditSummary | null {
  if (!filePath || (oldText === null && newText === null)) return null;
  return mergeStats([
    {
      filePath,
      added: changedLineCount(newText ?? ""),
      removed: changedLineCount(oldText ?? ""),
      previewLines: [
        ...linesFromText(oldText ?? "", "removed"),
        ...linesFromText(newText ?? "", "added"),
      ],
    },
  ]);
}

function mergeStats(stats: readonly EditFileStat[]): EditSummary | null {
  const byPath = new Map<string, EditFileStat>();
  for (const stat of stats) {
    if (!stat.filePath) continue;
    const existing = byPath.get(stat.filePath);
    if (existing) {
      existing.added += stat.added;
      existing.removed += stat.removed;
      // Separate each merged contribution with a hunk row so multiple
      // Edit calls to the same file render as visually distinct
      // chunks instead of one tall blob. Skip when either side is
      // empty (avoids a leading or trailing separator with no
      // surrounding content).
      const merged = stat.previewLines.length > 0 && existing.previewLines.length > 0
        ? [
            ...existing.previewLines,
            {
              type: "hunk" as const,
              oldLineNumber: null,
              newLineNumber: null,
              content: "",
            },
            ...stat.previewLines,
          ]
        : [...existing.previewLines, ...stat.previewLines];
      existing.previewLines = capPreviewLines(merged);
    } else {
      byPath.set(stat.filePath, {
        ...stat,
        previewLines: capPreviewLines(stat.previewLines),
      });
    }
  }
  const files = [...byPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (files.length === 0) return null;
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

function parsePatchStats(patch: string): EditFileStat[] {
  const stats: EditFileStat[] = [];
  let current: EditFileStat | null = null;

  const beginCurrent = (filePath: string | null): EditFileStat | null => {
    if (!filePath || filePath === "/dev/null") return null;
    const next = {
      filePath: stripDiffPrefix(filePath),
      added: 0,
      removed: 0,
      previewLines: [],
    };
    stats.push(next);
    return next;
  };
  let oldLineNumber: number | null = null;
  let newLineNumber: number | null = null;

  for (const line of patch.split(/\r\n|\r|\n/)) {
    const fileMatch =
      line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ??
      line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      current = beginCurrent(fileMatch[1]);
      oldLineNumber = null;
      newLineNumber = null;
      continue;
    }

    const nextFile = line.match(/^\+\+\+ (.+)$/);
    if (nextFile && !current) {
      current = beginCurrent(nextFile[1]);
      oldLineNumber = null;
      newLineNumber = null;
      continue;
    }

    const active = current;
    if (!active) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[2]);
      // Emit a separator row for every `@@` after the first one in
      // this file, so multi-hunk patches break up vertically. Skip
      // the leading separator since the file header already opens
      // the first hunk visually.
      if (active.previewLines.length > 0) {
        pushPreviewLine(active, {
          type: "hunk",
          oldLineNumber: null,
          newLineNumber: null,
          content: line,
        });
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) {
      continue;
    }
    if (line.startsWith("+")) {
      active.added += 1;
      pushPreviewLine(active, {
        type: "added",
        oldLineNumber: null,
        newLineNumber,
        content: line.slice(1),
      });
      if (newLineNumber !== null) newLineNumber += 1;
    } else if (line.startsWith("-")) {
      active.removed += 1;
      pushPreviewLine(active, {
        type: "removed",
        oldLineNumber,
        newLineNumber: null,
        content: line.slice(1),
      });
      if (oldLineNumber !== null) oldLineNumber += 1;
    } else if (line.startsWith(" ")) {
      pushPreviewLine(active, {
        type: "context",
        oldLineNumber,
        newLineNumber,
        content: line.slice(1),
      });
      if (oldLineNumber !== null) oldLineNumber += 1;
      if (newLineNumber !== null) newLineNumber += 1;
    }
  }

  return stats.filter((stat) => stat.added > 0 || stat.removed > 0);
}

function stripDiffPrefix(filePath: string): string {
  return filePath.replace(/^[ab]\//, "");
}

function changedLineCount(value: string): number {
  if (value.length === 0) return 0;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

function linesFromText(
  value: string,
  type: Exclude<EditPreviewLineType, "context">,
): EditPreviewLine[] {
  return splitChangedLines(value)
    .slice(0, MAX_PREVIEW_LINES_PER_FILE)
    .map((content, index) => ({
      type,
      oldLineNumber: type === "removed" ? index + 1 : null,
      newLineNumber: type === "added" ? index + 1 : null,
      content,
    }));
}

function splitChangedLines(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}

function pushPreviewLine(stat: EditFileStat, line: EditPreviewLine) {
  if (stat.previewLines.length >= MAX_PREVIEW_LINES_PER_FILE) return;
  stat.previewLines.push(line);
}

function capPreviewLines(lines: readonly EditPreviewLine[]): EditPreviewLine[] {
  return lines.slice(0, MAX_PREVIEW_LINES_PER_FILE);
}

function parseJsonRecord(inputJson: string): JsonRecord | null {
  try {
    return recordFromUnknown(JSON.parse(inputJson));
  } catch {
    return null;
  }
}

function recordFromUnknown(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(record: JsonRecord | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}
