import { describe, it, expect } from "vitest";
import { checkpointHasFileChanges, clearAllHasFileChanges, buildRollbackMap } from "./checkpointUtils";
import type { ConversationCheckpoint } from "../types/checkpoint";
import type { ChatMessage } from "../types/chat";

function cp(
  id: string,
  commitHash: string | null,
  turnIndex: number,
  hasFileState = false,
): ConversationCheckpoint {
  return {
    id,
    workspace_id: "ws",
    message_id: `m-${id}`,
    commit_hash: commitHash,
    has_file_state: hasFileState,
    turn_index: turnIndex,
    message_count: 1,
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

  it("returns true when target is the latest checkpoint (worktree may have drifted)", () => {
    const target = cp("cp2", "bbb", 1);
    const all = [cp("cp1", "aaa", 0), cp("cp2", "bbb", 1)];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
  });

  it("returns true when target is the only checkpoint", () => {
    const target = cp("cp1", "aaa", 0);
    const all = [cp("cp1", "aaa", 0)];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
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

  it("returns true when has_file_state is true (SQLite snapshot)", () => {
    const target = cp("cp1", null, 0, true);
    const all = [cp("cp1", null, 0, true), cp("cp2", null, 1, true)];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
  });

  it("returns true when has_file_state is true even with no commit_hash", () => {
    const target = cp("cp1", null, 0, true);
    const all = [cp("cp1", null, 0, true)];
    expect(checkpointHasFileChanges(target, all)).toBe(true);
  });

  it("returns false when neither has_file_state nor commit_hash", () => {
    const target = cp("cp1", null, 0, false);
    const all = [cp("cp1", null, 0, false)];
    expect(checkpointHasFileChanges(target, all)).toBe(false);
  });
});

describe("clearAllHasFileChanges", () => {
  it("returns false when no checkpoints exist", () => {
    expect(clearAllHasFileChanges([])).toBe(false);
  });

  it("returns false when no checkpoints have commit hashes", () => {
    expect(clearAllHasFileChanges([cp("cp1", null, 0), cp("cp2", null, 1)])).toBe(false);
  });

  it("returns true when all checkpoints have the same hash (files were edited)", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", "aaa", 0),
      cp("cp2", "aaa", 1),
      cp("cp3", "aaa", 2),
    ])).toBe(true);
  });

  it("returns true when only one checkpoint has a hash (single file-editing turn)", () => {
    expect(clearAllHasFileChanges([cp("cp1", "aaa", 0)])).toBe(true);
  });

  it("returns true when checkpoints have different hashes", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", "aaa", 0),
      cp("cp2", "bbb", 1),
    ])).toBe(true);
  });

  it("returns true with mix of null and different hashes", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", null, 0),
      cp("cp2", "aaa", 1),
      cp("cp3", "bbb", 2),
    ])).toBe(true);
  });

  it("returns true with mix of null and same hashes (files were still edited)", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", null, 0),
      cp("cp2", "aaa", 1),
      cp("cp3", "aaa", 2),
    ])).toBe(true);
  });

  it("returns true when checkpoints have has_file_state (SQLite snapshots)", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", null, 0, true),
      cp("cp2", null, 1, true),
    ])).toBe(true);
  });

  it("returns true with mix of snapshot and legacy checkpoints", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", "aaa", 0, false),
      cp("cp2", null, 1, true),
    ])).toBe(true);
  });

  it("returns false when no checkpoints have file state or commit hash", () => {
    expect(clearAllHasFileChanges([
      cp("cp1", null, 0, false),
      cp("cp2", null, 1, false),
    ])).toBe(false);
  });
});

function msg(id: string, role: "User" | "Assistant" | "System"): ChatMessage {
  return { id, workspace_id: "ws", chat_session_id: "ws", role, content: "", cost_usd: null, duration_ms: null, created_at: "", thinking: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, author_participant_id: null, author_display_name: null };
}

describe("buildRollbackMap", () => {
  it("maps first user message to null (clear-all) when checkpoints exist", () => {
    const messages = [msg("m1", "User"), msg("m2", "Assistant")];
    const cps = [cp("cp1", "aaa", 0)];
    cps[0].message_id = "m2";
    const result = buildRollbackMap(messages, cps);
    expect(result.get(0)).toBeNull();
  });

  it("maps first user message to null (clear-all) even with no checkpoints", () => {
    const messages = [msg("m1", "User"), msg("m2", "Assistant")];
    const result = buildRollbackMap(messages, []);
    expect(result.get(0)).toBeNull();
  });

  it("maps user message to checkpoint on preceding assistant message", () => {
    const messages = [
      msg("m1", "User"), msg("m2", "Assistant"),
      msg("m3", "User"), msg("m4", "Assistant"),
    ];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m2" }];
    const result = buildRollbackMap(messages, cps);
    expect(result.get(2)?.id).toBe("cp1");
  });

  it("scans backward past interrupted turn to find checkpoint", () => {
    // Turn 1: user → assistant (checkpoint), Turn 2: user → assistant (no checkpoint, stopped)
    const messages = [
      msg("m1", "User"), msg("m2", "Assistant"),
      msg("m3", "User"), msg("m4", "Assistant"),
      msg("m5", "User"),
    ];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m2" }];
    const result = buildRollbackMap(messages, cps);
    // m5 (index 4) should find cp1 by scanning backward past m4 (no cp) to m2
    expect(result.get(4)?.id).toBe("cp1");
  });

  it("returns only clear-all when no checkpoints exist", () => {
    const messages = [msg("m1", "User"), msg("m2", "Assistant")];
    const result = buildRollbackMap(messages, []);
    // First user message gets clear-all, but no other rollback points
    expect(result.size).toBe(1);
    expect(result.get(0)).toBeNull();
  });

  it("skips assistant messages (only user messages get rollback)", () => {
    const messages = [
      msg("m1", "User"), msg("m2", "Assistant"),
    ];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m2" }];
    const result = buildRollbackMap(messages, cps);
    // Only index 0 (user message) should be in the map
    expect(result.has(0)).toBe(true);
    expect(result.has(1)).toBe(false);
  });

  it("handles multiple checkpoints across turns", () => {
    const messages = [
      msg("m1", "User"), msg("m2", "Assistant"),
      msg("m3", "User"), msg("m4", "Assistant"),
      msg("m5", "User"),
    ];
    const cps = [
      { ...cp("cp1", "aaa", 0), message_id: "m2" },
      { ...cp("cp2", "bbb", 1), message_id: "m4" },
    ];
    const result = buildRollbackMap(messages, cps);
    expect(result.get(0)).toBeNull(); // clear-all
    expect(result.get(2)?.id).toBe("cp1"); // rolls back to turn 1
    expect(result.get(4)?.id).toBe("cp2"); // rolls back to turn 2
  });

  it("first user message always gets clear-all regardless of gaps", () => {
    const messages = [msg("m1", "User"), msg("m2", "Assistant")];
    // Checkpoint exists but not on m2 — doesn't matter for index 0
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "some-other-id" }];
    const result = buildRollbackMap(messages, cps);
    expect(result.get(0)).toBeNull();
  });

  it("maps first user message to null when system messages precede it", () => {
    const messages = [
      msg("m0", "System"),
      msg("m1", "System"),
      msg("m2", "User"),
      msg("m3", "Assistant"),
    ];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m3" }];
    const result = buildRollbackMap(messages, cps);
    // First user message at index 2 should get clear-all
    expect(result.get(2)).toBeNull();
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
  });

  // When the loaded `messages` array is a paginated window into a longer
  // session, the top user is NOT the conversation root and must NOT get the
  // clear-all sentinel — that would let users wipe the whole session by
  // clicking rollback on a top-of-window user.
  it("suppresses clear-all on top user when globalOffset > 0", () => {
    const messages = [msg("m50", "User"), msg("m51", "Assistant")];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m51" }];
    const result = buildRollbackMap(messages, cps, /* globalOffset */ 50);
    // Top user (index 0) is NOT the root, so no clear-all entry.
    expect(result.has(0)).toBe(false);
  });

  it("falls back to latest preceding checkpoint for top user on paginated window", () => {
    // The top user has a preceding checkpoint inside the window — it should
    // resolve to that checkpoint, not clear-all.
    const messages = [
      msg("m50", "Assistant"), // carry-over assistant from previous page
      msg("m51", "User"),
      msg("m52", "Assistant"),
    ];
    const cps = [{ ...cp("cp1", "aaa", 0), message_id: "m50" }];
    const result = buildRollbackMap(messages, cps, /* globalOffset */ 50);
    expect(result.get(1)?.id).toBe("cp1");
  });

  it("globalOffset = 0 still maps top user to clear-all (default behavior)", () => {
    const messages = [msg("m1", "User"), msg("m2", "Assistant")];
    const result = buildRollbackMap(messages, [], 0);
    expect(result.get(0)).toBeNull();
  });
});
