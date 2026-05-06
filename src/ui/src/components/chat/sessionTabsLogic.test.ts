import { describe, expect, it } from "vitest";
import {
  closeScopeForTabContext,
  computeSessionPersistOrder,
  splitUnifiedTabOrder,
  type UnifiedTabEntry,
} from "./sessionTabsLogic";
import type { ChatSession, DiffFileTab } from "../../types";

const session = (id: string): ChatSession => ({
  id,
  workspace_id: "ws-1",
  session_id: null,
  name: `s-${id}`,
  name_edited: false,
  turn_count: 0,
  sort_order: 0,
  status: "Active",
  created_at: "2026-01-01T00:00:00Z",
  archived_at: null,
  agent_status: "Idle",
  needs_attention: false,
  attention_kind: null,
});

const diff = (path: string): DiffFileTab => ({
  path,
  layer: null,
});

describe("computeSessionPersistOrder", () => {
  it("walks the unified order and emits session ids in display order", () => {
    const entries: UnifiedTabEntry[] = [
      { kind: "session", sessionId: "s2" },
      { kind: "file", path: "a.ts" },
      { kind: "session", sessionId: "s1" },
      { kind: "diff", path: "b.ts", layer: null },
      { kind: "session", sessionId: "s3" },
    ];
    expect(computeSessionPersistOrder(entries)).toEqual(["s2", "s1", "s3"]);
  });

  it("returns an empty array when no session entries are present", () => {
    const entries: UnifiedTabEntry[] = [
      { kind: "file", path: "a.ts" },
      { kind: "diff", path: "b.ts", layer: null },
    ];
    expect(computeSessionPersistOrder(entries)).toEqual([]);
  });
});

describe("splitUnifiedTabOrder", () => {
  it("splits a unified order back into per-kind arrays + a session persist sequence", () => {
    const sessions = [session("s1"), session("s2")];
    const diffs = [diff("a.ts"), diff("b.ts")];
    const files = ["x.ts", "y.ts"];
    const entries: UnifiedTabEntry[] = [
      { kind: "file", path: "y.ts" },
      { kind: "session", sessionId: "s2" },
      { kind: "diff", path: "a.ts", layer: null },
      { kind: "session", sessionId: "s1" },
      { kind: "file", path: "x.ts" },
      { kind: "diff", path: "b.ts", layer: null },
    ];
    const split = splitUnifiedTabOrder(entries, sessions, diffs, files);
    expect(split.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(split.diffs.map((d) => d.path)).toEqual(["a.ts", "b.ts"]);
    expect(split.files).toEqual(["y.ts", "x.ts"]);
    expect(split.sessionPersistIds).toEqual(["s2", "s1"]);
  });

  it("ignores entries that no longer exist in the current per-kind state", () => {
    // e.g. a session was archived between the drop and the split: its entry
    // is dropped silently rather than propagated as a phantom row.
    const split = splitUnifiedTabOrder(
      [
        { kind: "session", sessionId: "s-missing" },
        { kind: "session", sessionId: "s1" },
      ],
      [session("s1")],
      [],
      [],
    );
    expect(split.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(split.sessionPersistIds).toEqual(["s-missing", "s1"]);
  });
});

describe("closeScopeForTabContext", () => {
  const entries = [
    { key: "s:1", kind: "session" as const },
    { key: "f:a.ts", kind: "file" as const },
    { key: "d:b.ts", kind: "diff" as const },
    { key: "f:c.ts", kind: "file" as const },
  ];

  it("scopes file-tab close actions to file tabs only", () => {
    expect(closeScopeForTabContext(entries, "f:a.ts").map((e) => e.key)).toEqual([
      "f:a.ts",
      "f:c.ts",
    ]);
  });

  it("keeps session and diff tab close actions scoped to the full strip", () => {
    expect(closeScopeForTabContext(entries, "s:1").map((e) => e.key)).toEqual(
      entries.map((e) => e.key),
    );
    expect(closeScopeForTabContext(entries, "d:b.ts").map((e) => e.key)).toEqual(
      entries.map((e) => e.key),
    );
  });
});
