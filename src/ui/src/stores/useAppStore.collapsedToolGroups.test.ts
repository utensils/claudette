import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

describe("collapsedToolGroupsBySession", () => {
  beforeEach(() => {
    useAppStore.setState({
      collapsedToolGroupsBySession: {},
      expandedToolUseIds: {},
    });
  });

  it("starts empty for a fresh session", () => {
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A],
    ).toBeUndefined();
  });

  it("setCollapsedToolGroup sets a per-(session, groupKey) override", () => {
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "turn1:tool-1", true);
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A]?.[
        "turn1:tool-1"
      ],
    ).toBe(true);
  });

  it("doesn't toggle siblings sharing the same turn-id prefix", () => {
    // Regression for the bug where chronologically-split groups all
    // shared `turn.collapsed`: clicking one chevron should leave its
    // siblings untouched.
    useAppStore
      .getState()
      .setCollapsedToolGroup(SESSION_A, "turn1:tool-a", true);
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A]?.[
        "turn1:tool-a"
      ],
    ).toBe(true);
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A]?.[
        "turn1:tool-b"
      ],
    ).toBeUndefined();
  });

  it("scopes overrides per session", () => {
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "g1", true);
    useAppStore.getState().setCollapsedToolGroup(SESSION_B, "g1", false);
    const state = useAppStore.getState();
    expect(state.collapsedToolGroupsBySession[SESSION_A]?.g1).toBe(true);
    expect(state.collapsedToolGroupsBySession[SESSION_B]?.g1).toBe(false);
  });

  it("re-setting the same value is a no-op (reference-stable)", () => {
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "g1", true);
    const before = useAppStore.getState().collapsedToolGroupsBySession;
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "g1", true);
    const after = useAppStore.getState().collapsedToolGroupsBySession;
    // Identity preserved → no needless re-render of subscribers.
    expect(after).toBe(before);
  });

  it("setting then clearing produces inverse boolean values", () => {
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "g1", true);
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A]?.g1,
    ).toBe(true);
    useAppStore.getState().setCollapsedToolGroup(SESSION_A, "g1", false);
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_A]?.g1,
    ).toBe(false);
  });
});

describe("expandedToolUseIds", () => {
  beforeEach(() => {
    useAppStore.setState({ expandedToolUseIds: {} });
  });

  it("toggles a tool use id on and off", () => {
    useAppStore.getState().toggleToolUseExpanded("tool-1");
    expect(useAppStore.getState().expandedToolUseIds["tool-1"]).toBe(true);

    useAppStore.getState().toggleToolUseExpanded("tool-1");
    expect(useAppStore.getState().expandedToolUseIds["tool-1"]).toBeUndefined();
  });

  it("keeps different tool use ids independent", () => {
    useAppStore.getState().toggleToolUseExpanded("tool-1");
    useAppStore.getState().toggleToolUseExpanded("tool-2");
    useAppStore.getState().toggleToolUseExpanded("tool-1");

    expect(useAppStore.getState().expandedToolUseIds["tool-1"]).toBeUndefined();
    expect(useAppStore.getState().expandedToolUseIds["tool-2"]).toBe(true);
  });
});
