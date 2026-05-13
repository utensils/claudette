import { relativizePath } from "../../hooks/toolSummary";
import { parseFilePathTarget } from "../../utils/filePathLinks";

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
  const rel = relativizePath(parsed.path, worktreePath);
  if (
    /^([a-zA-Z]:[\\/]|[\\/])/.test(rel) ||
    rel === "~" ||
    rel.startsWith("~/") ||
    rel.startsWith("~\\") ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return null;
  }
  const path = rel.replace(/^\.[\\/]/, "");
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
