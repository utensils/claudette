import { relativizePath } from "../../hooks/toolSummary";
import {
  extractClaudetteWorktreeRelativePath,
  parseFilePathTarget,
} from "../../utils/filePathLinks";

export interface MonacoFileRevealTarget {
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
}

export interface MonacoFileLinkTarget {
  path: string;
  revealTarget?: MonacoFileRevealTarget;
}

export function monacoFileLinkPath(
  filePath: string,
  worktreePath: string | null | undefined,
): string | null {
  return monacoFileLinkTarget(filePath, worktreePath)?.path ?? null;
}

export function monacoFileLinkTarget(
  filePath: string,
  worktreePath: string | null | undefined,
): MonacoFileLinkTarget | null {
  const parsed = parseFilePathTarget(filePath);
  let rel = relativizePath(parsed.path, worktreePath);
  if (
    /^([a-zA-Z]:[\\/]|[\\/])/.test(rel) ||
    rel === "~" ||
    rel.startsWith("~/") ||
    rel.startsWith("~\\")
  ) {
    // Absolute or home-relative after stripping the current worktree —
    // the path points outside `worktreePath`. If it's still inside *some*
    // Claudette-managed worktree of the same project, fall through to the
    // workspace-relative form so the equivalent file opens in the current
    // worktree's Monaco. Otherwise let the caller defer to the OS opener.
    const fromOtherWorktree = extractClaudetteWorktreeRelativePath(rel);
    if (!fromOtherWorktree) return null;
    rel = fromOtherWorktree;
  } else if (
    rel === "." ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return null;
  }
  const path = rel.replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  const revealTarget =
    typeof parsed.startLine === "number"
      ? {
          startLine: parsed.startLine,
          startColumn: parsed.startColumn,
          endLine: parsed.endLine ?? parsed.startLine,
          endColumn: parsed.endColumn,
        }
      : undefined;
  return revealTarget ? { path, revealTarget } : { path };
}
