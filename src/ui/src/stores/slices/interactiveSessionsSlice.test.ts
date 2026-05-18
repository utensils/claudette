// Coverage for the interactive-sessions slice. The slice is small —
// just two setters keyed by workspace id — but the badge selector in
// the sidebar treats undefined vs `[]` identically, and the
// clear-on-missing-key short-circuit must stay reference-stable to keep
// subscribers calm. Tests pin both behaviors.

import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../useAppStore";
import type { InteractiveSessionRow } from "../../services/interactive";

function makeRow(
  overrides: Partial<InteractiveSessionRow> = {},
): InteractiveSessionRow {
  return {
    sid: "is-1",
    workspaceId: "ws-1",
    hostKind: "tmux",
    state: "running",
    crashReason: null,
    createdAt: "2026-05-18T00:00:00Z",
    lastAttachedAt: null,
    lastScreenBlob: null,
    claudeFlagsJson: "{}",
    pid: null,
    ...overrides,
  };
}

describe("interactiveSessionsSlice", () => {
  beforeEach(() => {
    useAppStore.setState({ interactiveSessionsByWorkspace: {} });
  });

  it("setInteractiveSessionsForWorkspace replaces the row list for one workspace", () => {
    const rowsA = [makeRow({ sid: "a-1" }), makeRow({ sid: "a-2" })];
    const rowsB = [makeRow({ sid: "b-1", workspaceId: "ws-2" })];

    useAppStore.getState().setInteractiveSessionsForWorkspace("ws-1", rowsA);
    useAppStore.getState().setInteractiveSessionsForWorkspace("ws-2", rowsB);

    expect(
      useAppStore.getState().interactiveSessionsByWorkspace,
    ).toEqual({ "ws-1": rowsA, "ws-2": rowsB });

    // Replacing must overwrite, not merge.
    const replacement = [makeRow({ sid: "a-3" })];
    useAppStore
      .getState()
      .setInteractiveSessionsForWorkspace("ws-1", replacement);
    expect(
      useAppStore.getState().interactiveSessionsByWorkspace["ws-1"],
    ).toEqual(replacement);
  });

  it("setInteractiveSessionsForWorkspace accepts an empty list (no-rows signal)", () => {
    useAppStore.getState().setInteractiveSessionsForWorkspace("ws-1", []);
    expect(
      useAppStore.getState().interactiveSessionsByWorkspace["ws-1"],
    ).toEqual([]);
  });

  it("clearInteractiveSessionsForWorkspace removes the entry", () => {
    useAppStore.getState().setInteractiveSessionsForWorkspace("ws-1", [
      makeRow({ sid: "a-1" }),
    ]);
    useAppStore.getState().setInteractiveSessionsForWorkspace("ws-2", [
      makeRow({ sid: "b-1", workspaceId: "ws-2" }),
    ]);

    useAppStore.getState().clearInteractiveSessionsForWorkspace("ws-1");

    expect(
      useAppStore.getState().interactiveSessionsByWorkspace,
    ).toEqual({
      "ws-2": [makeRow({ sid: "b-1", workspaceId: "ws-2" })],
    });
  });

  it("clearInteractiveSessionsForWorkspace is reference-stable when the key is missing", () => {
    // The slice short-circuits to keep selectors / sidebar subscribers
    // from rerendering on no-op clears (e.g. cleanup on a workspace that
    // never had an interactive session loaded).
    const before = useAppStore.getState();
    useAppStore.getState().clearInteractiveSessionsForWorkspace("never-seen");
    expect(useAppStore.getState()).toBe(before);
  });
});
