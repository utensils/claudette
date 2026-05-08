import { describe, expect, it } from "vitest";
import {
  buildWorkspaceTabNavEntries,
  closeScopeForTabContext,
  computeSessionPersistOrder,
  cycleNavEntries,
  diffNavKey,
  fileNavKey,
  findActiveNavEntryKey,
  sessionNavKey,
  splitUnifiedTabOrder,
  type NavEntry,
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
  cli_invocation: null,
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

  it("allows callers to include file-adjacent entries in file-tab close scope", () => {
    expect(
      closeScopeForTabContext(
        entries,
        "f:a.ts",
        (entry) => entry.kind === "diff" && entry.key === "d:b.ts",
      ).map((e) => e.key),
    ).toEqual(["f:a.ts", "d:b.ts", "f:c.ts"]);
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

describe("buildWorkspaceTabNavEntries", () => {
  it("falls back to sessions → diffs → files when no saved order exists", () => {
    const entries = buildWorkspaceTabNavEntries({
      activeSessions: [session("s1"), session("s2")],
      diffTabs: [diff("a.ts")],
      fileTabs: ["x.ts", "y.ts"],
      tabOrder: undefined,
    });
    expect(entries.map((e) => e.key)).toEqual([
      sessionNavKey("s1"),
      sessionNavKey("s2"),
      diffNavKey("a.ts", null),
      fileNavKey("x.ts"),
      fileNavKey("y.ts"),
    ]);
  });

  it("honors a saved drag order and appends newly-opened tabs at the end", () => {
    const tabOrder: UnifiedTabEntry[] = [
      { kind: "file", path: "x.ts" },
      { kind: "session", sessionId: "s2" },
      { kind: "diff", path: "a.ts", layer: null },
    ];
    const entries = buildWorkspaceTabNavEntries({
      // y.ts is new — it wasn't in tabOrder yet, so it should append.
      activeSessions: [session("s1"), session("s2")],
      diffTabs: [diff("a.ts")],
      fileTabs: ["x.ts", "y.ts"],
      tabOrder,
    });
    expect(entries.map((e) => e.key)).toEqual([
      fileNavKey("x.ts"),
      sessionNavKey("s2"),
      diffNavKey("a.ts", null),
      sessionNavKey("s1"),
      fileNavKey("y.ts"),
    ]);
  });

  it("drops saved entries whose underlying tabs have closed", () => {
    const tabOrder: UnifiedTabEntry[] = [
      { kind: "session", sessionId: "s-archived" },
      { kind: "session", sessionId: "s1" },
      { kind: "file", path: "deleted.ts" },
    ];
    const entries = buildWorkspaceTabNavEntries({
      activeSessions: [session("s1")],
      diffTabs: [],
      fileTabs: [],
      tabOrder,
    });
    expect(entries.map((e) => e.key)).toEqual([sessionNavKey("s1")]);
  });
});

describe("findActiveNavEntryKey", () => {
  it("prefers an active file tab over diff or session selection", () => {
    expect(
      findActiveNavEntryKey({
        selectedSessionId: "s1",
        diffSelectedFile: "a.ts",
        diffSelectedLayer: null,
        activeFileTab: "x.ts",
      }),
    ).toBe(fileNavKey("x.ts"));
  });

  it("falls back to the diff selection when no file tab is active", () => {
    expect(
      findActiveNavEntryKey({
        selectedSessionId: "s1",
        diffSelectedFile: "a.ts",
        diffSelectedLayer: "unstaged",
        activeFileTab: null,
      }),
    ).toBe(diffNavKey("a.ts", "unstaged"));
  });

  it("falls back to the selected session when neither file nor diff is active", () => {
    expect(
      findActiveNavEntryKey({
        selectedSessionId: "s1",
        diffSelectedFile: null,
        diffSelectedLayer: null,
        activeFileTab: null,
      }),
    ).toBe(sessionNavKey("s1"));
  });

  it("returns null when nothing in the workspace is selected", () => {
    expect(
      findActiveNavEntryKey({
        selectedSessionId: null,
        diffSelectedFile: null,
        diffSelectedLayer: null,
        activeFileTab: null,
      }),
    ).toBeNull();
  });
});

describe("cycleNavEntries", () => {
  const entries: NavEntry[] = [
    { key: sessionNavKey("s1"), kind: "session", sessionId: "s1" },
    { key: sessionNavKey("s2"), kind: "session", sessionId: "s2" },
    { key: diffNavKey("a.ts", null), kind: "diff", path: "a.ts", layer: null },
    { key: fileNavKey("x.ts"), kind: "file", path: "x.ts" },
  ];

  it("returns null for an empty strip and a no-op for a single tab", () => {
    expect(cycleNavEntries([], null, "next")).toBeNull();
    expect(cycleNavEntries([entries[0]], entries[0].key, "next")).toEqual(entries[0]);
    expect(cycleNavEntries([entries[0]], entries[0].key, "prev")).toEqual(entries[0]);
  });

  it("advances forward with wrap-around", () => {
    expect(cycleNavEntries(entries, sessionNavKey("s1"), "next")?.key).toBe(
      sessionNavKey("s2"),
    );
    expect(cycleNavEntries(entries, fileNavKey("x.ts"), "next")?.key).toBe(
      sessionNavKey("s1"),
    );
  });

  it("advances backward with wrap-around", () => {
    expect(cycleNavEntries(entries, sessionNavKey("s2"), "prev")?.key).toBe(
      sessionNavKey("s1"),
    );
    expect(cycleNavEntries(entries, sessionNavKey("s1"), "prev")?.key).toBe(
      fileNavKey("x.ts"),
    );
  });

  it("starts at the first entry on next when nothing is active", () => {
    expect(cycleNavEntries(entries, null, "next")?.key).toBe(sessionNavKey("s1"));
  });

  it("starts at the last entry on prev when nothing is active", () => {
    expect(cycleNavEntries(entries, null, "prev")?.key).toBe(fileNavKey("x.ts"));
  });

  it("treats an unknown active key as 'no current tab'", () => {
    expect(cycleNavEntries(entries, "s:bogus", "next")?.key).toBe(sessionNavKey("s1"));
    expect(cycleNavEntries(entries, "f:bogus.ts", "prev")?.key).toBe(fileNavKey("x.ts"));
  });
});
