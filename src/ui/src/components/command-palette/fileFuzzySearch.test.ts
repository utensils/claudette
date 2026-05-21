import { describe, expect, it } from "vitest";
import {
  prepareFileSearchIndex,
  searchFileIndex,
} from "./fileFuzzySearch";
import type { FileEntry } from "./commands";

function files(paths: string[]): FileEntry[] {
  return paths.map((path) => ({ path, is_directory: false }));
}

describe("fileFuzzySearch", () => {
  it("matches VSCode-style basename subsequences", () => {
    const index = prepareFileSearchIndex(files([
      "src/ui/FooBarPanel.tsx",
      "src/ui/FooPanel.tsx",
      "src/ui/bar.ts",
    ]));

    const results = searchFileIndex(index, "fbp");

    expect(results[0]?.entry.path).toBe("src/ui/FooBarPanel.tsx");
    expect(results[0]?.basenameMatches).toEqual([0, 3, 6]);
  });

  it("matches mid-path subsequences and returns full-path ranges", () => {
    const index = prepareFileSearchIndex(files([
      "src/ui/src/components/command-palette/CommandPalette.tsx",
      "src/ui/src/components/chat/ChatPanel.tsx",
    ]));

    const results = searchFileIndex(index, "cmdpal");

    expect(results[0]?.entry.path).toBe(
      "src/ui/src/components/command-palette/CommandPalette.tsx",
    );
    expect(results[0]?.pathMatches.length).toBe(6);
    expect(results[0]?.pathMatches[0]).toBeGreaterThan(0);
  });

  it("ranks exact and prefix basename matches above path-only matches", () => {
    const index = prepareFileSearchIndex(files([
      "src/actions/command.ts",
      "src/components/CommandPalette.tsx",
      "src/command/palette.ts",
    ]));

    const [first, second, third] = searchFileIndex(index, "command");

    expect(first.entry.path).toBe("src/actions/command.ts");
    expect(second.entry.path).toBe("src/components/CommandPalette.tsx");
    expect(third.entry.path).toBe("src/command/palette.ts");
  });

  it("filters directories out of the prepared index", () => {
    const index = prepareFileSearchIndex([
      { path: "src/components", is_directory: true },
      { path: "src/components/App.tsx", is_directory: false },
    ]);

    expect(index.map((entry) => entry.path)).toEqual(["src/components/App.tsx"]);
  });

  it("bounds empty-query results instead of returning every file", () => {
    const index = prepareFileSearchIndex(
      Array.from({ length: 10_000 }, (_, i) => ({
        path: `src/generated/File${i}.ts`,
        is_directory: false,
      })),
    );

    const results = searchFileIndex(index, "", 200);

    expect(results).toHaveLength(200);
    expect(results[0]?.entry.path).toBe("src/generated/File0.ts");
  });

  it("bounds broad fuzzy-query results instead of returning every match", () => {
    const index = prepareFileSearchIndex(
      Array.from({ length: 10_000 }, (_, i) => ({
        path: `src/alpha/File${i}.ts`,
        is_directory: false,
      })),
    );

    const results = searchFileIndex(index, "a", 50);

    expect(results).toHaveLength(50);
    expect(results.every((result) => result.pathMatches.length > 0)).toBe(true);
  });

  it("keeps large-list fuzzy matching bounded by the top result limit", () => {
    const index = prepareFileSearchIndex([
      ...Array.from({ length: 10_000 }, (_, i) => ({
        path: `src/generated/Component${i}.tsx`,
        is_directory: false,
      })),
      { path: "src/ui/FooBarPanel.tsx", is_directory: false },
    ]);

    const results = searchFileIndex(index, "fbp", 20);

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.path).toBe("src/ui/FooBarPanel.tsx");
  });
});
