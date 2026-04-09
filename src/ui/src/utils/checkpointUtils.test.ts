import { describe, it, expect } from "vitest";
import { checkpointHasFileChanges } from "./checkpointUtils";
import type { ConversationCheckpoint } from "../types/checkpoint";

function cp(
  id: string,
  commitHash: string | null,
  turnIndex: number,
): ConversationCheckpoint {
  return {
    id,
    workspace_id: "ws",
    message_id: `m-${id}`,
    commit_hash: commitHash,
    turn_index: turnIndex,
    created_at: "",
  };
}

describe("checkpointHasFileChanges", () => {
  it("returns true when commit hash differs from latest", () => {
    const target = cp("cp1", "aaa", 0);
    const all = [cp("cp1", "aaa", 0), cp("cp2", "bbb", 1)];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
  });

  it("returns false when commit hash matches latest (no file changes)", () => {
    const target = cp("cp1", "aaa", 0);
    const all = [cp("cp1", "aaa", 0), cp("cp2", "aaa", 1)];
    expect(checkpointHasFileChanges(target, all)).toBe(false);
  });

  it("returns false when checkpoint has no commit hash", () => {
    const target = cp("cp1", null, 0);
    const all = [cp("cp1", null, 0), cp("cp2", "bbb", 1)];
    expect(checkpointHasFileChanges(target, all)).toBe(false);
  });

  it("returns false when checkpoints array is empty", () => {
    const target = cp("cp1", "aaa", 0);
    expect(checkpointHasFileChanges(target, [])).toBe(false);
  });

  it("returns false when target is the latest checkpoint", () => {
    const target = cp("cp2", "bbb", 1);
    const all = [cp("cp1", "aaa", 0), cp("cp2", "bbb", 1)];
    expect(checkpointHasFileChanges(target, all)).toBe(false);
  });

  it("returns true across multiple turns with different hashes", () => {
    const target = cp("cp1", "aaa", 0);
    const all = [
      cp("cp1", "aaa", 0),
      cp("cp2", "aaa", 1), // no file change
      cp("cp3", "ccc", 2), // file change
    ];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
  });

  it("returns false across multiple turns with same hash", () => {
    const target = cp("cp1", "aaa", 0);
    const all = [
      cp("cp1", "aaa", 0),
      cp("cp2", "aaa", 1),
      cp("cp3", "aaa", 2),
    ];
    expect(checkpointHasFileChanges(target, all)).toBe(false);
  });
});
