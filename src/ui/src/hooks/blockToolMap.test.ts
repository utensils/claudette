import { describe, it, expect } from "vitest";
import {
  setBlockTool,
  getBlockTool,
  clearBlockToolsForSession,
  type BlockToolMap,
} from "./blockToolMap";

// Regression tests for issue #484. The map drives content_block_delta →
// tool input routing in useAgentStream. Before the fix it was a flat
// Record<number, …> keyed only by content-block index, so two concurrent
// sessions whose Anthropic API streams reused the same block index
// (which they routinely do — index 0 is the first block of every turn)
// would overwrite each other's tool ids, and a ProcessExited for either
// session blew away the whole map.

describe("blockToolMap", () => {
  describe("session isolation", () => {
    it("keeps two sessions' entries at the same content-block index separate", () => {
      const map: BlockToolMap = {};
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a", toolName: "Bash" });
      setBlockTool(map, "sessB", 0, { toolUseId: "tool-b", toolName: "Read" });

      expect(getBlockTool(map, "sessA", 0)).toEqual({
        toolUseId: "tool-a",
        toolName: "Bash",
      });
      expect(getBlockTool(map, "sessB", 0)).toEqual({
        toolUseId: "tool-b",
        toolName: "Read",
      });
    });

    it("scopes overwrites of the same index to a single session", () => {
      const map: BlockToolMap = {};
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a1", toolName: "Bash" });
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a2", toolName: "Edit" });
      setBlockTool(map, "sessB", 0, { toolUseId: "tool-b", toolName: "Read" });

      expect(getBlockTool(map, "sessA", 0)).toEqual({
        toolUseId: "tool-a2",
        toolName: "Edit",
      });
      expect(getBlockTool(map, "sessB", 0)).toEqual({
        toolUseId: "tool-b",
        toolName: "Read",
      });
    });

    it("returns undefined for a missing session even if another session has that index", () => {
      const map: BlockToolMap = {};
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a", toolName: "Bash" });
      expect(getBlockTool(map, "sessB", 0)).toBeUndefined();
    });
  });

  describe("clearBlockToolsForSession", () => {
    it("only clears entries for the exiting session", () => {
      const map: BlockToolMap = {};
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a", toolName: "Bash" });
      setBlockTool(map, "sessB", 0, { toolUseId: "tool-b", toolName: "Read" });
      setBlockTool(map, "sessB", 1, { toolUseId: "tool-b2", toolName: "Edit" });

      clearBlockToolsForSession(map, "sessA");

      expect(getBlockTool(map, "sessA", 0)).toBeUndefined();
      expect(getBlockTool(map, "sessB", 0)).toEqual({
        toolUseId: "tool-b",
        toolName: "Read",
      });
      expect(getBlockTool(map, "sessB", 1)).toEqual({
        toolUseId: "tool-b2",
        toolName: "Edit",
      });
    });

    it("is a no-op for a session with no entries", () => {
      const map: BlockToolMap = {};
      setBlockTool(map, "sessA", 0, { toolUseId: "tool-a", toolName: "Bash" });

      clearBlockToolsForSession(map, "sessB");

      expect(getBlockTool(map, "sessA", 0)).toEqual({
        toolUseId: "tool-a",
        toolName: "Bash",
      });
    });
  });
});
