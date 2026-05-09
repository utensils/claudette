import type { AgentToolCall, ToolActivity } from "../../stores/useAppStore";

export interface EditFileStat {
  filePath: string;
  added: number;
  removed: number;
}

export interface EditSummary {
  files: EditFileStat[];
  added: number;
  removed: number;
}

type JsonRecord = Record<string, unknown>;

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
    return mergeStats([{ filePath, added: changedLineCount(content), removed: 0 }]);
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
    const patch =
      stringField(input, "patch") ??
      stringField(input, "input") ??
      stringField(input, "cmd") ??
      stringField(input, "command");
    return patch ? mergeStats(parsePatchStats(patch)) : null;
  }

  return null;
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
    } else {
      byPath.set(stat.filePath, { ...stat });
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
    const next = { filePath: stripDiffPrefix(filePath), added: 0, removed: 0 };
    stats.push(next);
    return next;
  };

  for (const line of patch.split(/\r\n|\r|\n/)) {
    const fileMatch =
      line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ??
      line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      current = beginCurrent(fileMatch[1]);
      continue;
    }

    const nextFile = line.match(/^\+\+\+ (.+)$/);
    if (nextFile && !current) {
      current = beginCurrent(nextFile[1]);
      continue;
    }

    const active = current;
    if (!active) continue;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) {
      continue;
    }
    if (line.startsWith("+")) active.added += 1;
    else if (line.startsWith("-")) active.removed += 1;
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
