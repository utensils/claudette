export type FileStatus =
  | "Added"
  | "Modified"
  | "Deleted"
  | { Renamed: { from: string } };

export interface DiffFile {
  path: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
}

export type DiffLayer = "committed" | "staged" | "unstaged" | "untracked";

export interface DiffFileTab {
  path: string;
  layer: DiffLayer | null;
}

export interface DiffSelection {
  path: string;
  layer: DiffLayer | null;
}

export interface StagedDiffFiles {
  committed: DiffFile[];
  staged: DiffFile[];
  unstaged: DiffFile[];
  untracked: DiffFile[];
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
