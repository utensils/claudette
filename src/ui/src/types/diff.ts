export type FileStatus =
  | "Added"
  | "Modified"
  | "Deleted"
  | { Renamed: { from: string } };

export interface DiffFile {
  path: string;
  status: FileStatus;
}

export type DiffViewMode = "Unified" | "SideBySide";

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  is_binary: boolean;
}

export interface DiffHunk {
  old_start: number;
  new_start: number;
  header: string;
  lines: DiffLine[];
}

export type DiffLineType = "Context" | "Added" | "Removed";

export interface DiffLine {
  line_type: DiffLineType;
  content: string;
  old_line_number: number | null;
  new_line_number: number | null;
}
