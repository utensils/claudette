import { describe, expect, it } from "vitest";

import type { FileEntry } from "../../services/tauri";
import { matchFiles } from "./FileMentionPicker";

function file(path: string, isDirectory = false): FileEntry {
  return {
    path,
    is_directory: isDirectory,
  };
}

describe("matchFiles", () => {
  const files = [
    file("src/ui/src/components/chat/ChatPanel.tsx"),
    file("src/ui/src/components/chat/ChatInputArea.tsx"),
    file("src/ui/src/stores/useAppStore.ts"),
    file("src/ui/src/components/settings/PluginsSettings.tsx"),
    file("src-tauri/src/commands/settings.rs"),
    file("site/src/content/docs/features/settings.mdx"),
  ];

  it("keeps substring matches ranked above fuzzy matches", () => {
    const results = matchFiles(
      [
        file("src/ui/src/components/chat/ChatPanel.tsx"),
        file("src/ui/src/components/CoolHarnessTool.tsx"),
      ],
      "chat",
    );

    expect(results.map((result) => result.file.path)).toEqual([
      "src/ui/src/components/chat/ChatPanel.tsx",
      "src/ui/src/components/CoolHarnessTool.tsx",
    ]);
  });

  it("matches skipped characters in a filename", () => {
    expect(
      matchFiles(files, "chatpanl").map((result) => result.file.path),
    ).toContain("src/ui/src/components/chat/ChatPanel.tsx");
  });

  it("matches filename abbreviations as subsequences", () => {
    expect(
      matchFiles(files, "cpanel").map((result) => result.file.path),
    ).toContain("src/ui/src/components/chat/ChatPanel.tsx");
  });

  it("matches subsequences across path segments", () => {
    expect(
      matchFiles(files, "uiappstore").map((result) => result.file.path),
    ).toContain("src/ui/src/stores/useAppStore.ts");
  });

  it("does not match characters that only appear out of order", () => {
    expect(matchFiles(files, "storeappui")).toEqual([]);
  });

  it("keeps directory results ahead at equal substring relevance", () => {
    const results = matchFiles(
      [file("src/ui/example", false), file("src/ui/example", true)],
      "example",
    );

    expect(results[0]?.file.is_directory).toBe(true);
  });
});
