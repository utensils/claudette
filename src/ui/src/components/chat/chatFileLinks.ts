import { relativizePath } from "../../hooks/toolSummary";

export function monacoFileLinkPath(
  filePath: string,
  worktreePath: string | null | undefined,
): string | null {
  const rel = relativizePath(filePath, worktreePath);
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
  return rel.replace(/^\.[\\/]/, "");
}
