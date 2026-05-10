import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../useAppStore";

describe("uiSlice.manualWorkspaceOrderByRepo", () => {
  beforeEach(() => {
    useAppStore.setState({ manualWorkspaceOrderByRepo: {} });
  });

  it("marks and clears a single repo manual workspace order", () => {
    useAppStore.getState().markWorkspaceOrderManual("repo-a");
    useAppStore.getState().markWorkspaceOrderManual("repo-b");

    useAppStore.getState().clearManualWorkspaceOrder("repo-a");

    expect(useAppStore.getState().manualWorkspaceOrderByRepo).toEqual({
      "repo-b": "manual",
    });
  });

  it("keeps existing state object when clearing a repo that is already automatic", () => {
    const stateBefore = useAppStore.getState();

    useAppStore.getState().clearManualWorkspaceOrder("repo-a");

    expect(useAppStore.getState()).toBe(stateBefore);
  });
});

describe("uiSlice.expandRepo", () => {
  beforeEach(() => {
    useAppStore.setState({ repoCollapsed: {} });
  });

  it("removes a collapsed repo from the map", () => {
    // expandRepo deletes the key entirely instead of writing `false`
    // because absence is the canonical "expanded" state. Keeps the map
    // small over time as repos churn.
    useAppStore.setState({ repoCollapsed: { "repo-a": true, "repo-b": true } });

    useAppStore.getState().expandRepo("repo-a");

    expect(useAppStore.getState().repoCollapsed).toEqual({ "repo-b": true });
  });

  it("is a no-op when the repo is already expanded", () => {
    const before = useAppStore.getState();

    useAppStore.getState().expandRepo("repo-not-collapsed");

    // Reference-equal: the slice short-circuits to keep subscribers calm.
    expect(useAppStore.getState()).toBe(before);
  });

  it("cleans up a stale `false` entry instead of leaving it in the map", () => {
    // Defensive: nothing in the codebase writes `false` to repoCollapsed
    // anymore (toggleRepoCollapsed deletes on toggle-back), but expandRepo
    // is the canonicalizer of last resort — if a stale entry ever sneaks
    // in, the next expand call must purge it so the "absence === expanded"
    // invariant holds for selectors that use `id in repoCollapsed`.
    useAppStore.setState({ repoCollapsed: { "repo-a": false, "repo-b": true } });

    useAppStore.getState().expandRepo("repo-a");

    expect(useAppStore.getState().repoCollapsed).toEqual({ "repo-b": true });
  });
});

describe("uiSlice.toggleRepoCollapsed", () => {
  beforeEach(() => {
    useAppStore.setState({ repoCollapsed: {} });
  });

  it("collapses an absent repo by writing `true`", () => {
    useAppStore.getState().toggleRepoCollapsed("repo-a");
    expect(useAppStore.getState().repoCollapsed).toEqual({ "repo-a": true });
  });

  it("expands a collapsed repo by deleting the key (not writing false)", () => {
    // The map's invariant is "absence === expanded". Writing `false` would
    // accumulate stale entries over time as repos churn through collapse
    // cycles. Deleting on toggle-back keeps it canonical at the source.
    useAppStore.setState({ repoCollapsed: { "repo-a": true, "repo-b": true } });

    useAppStore.getState().toggleRepoCollapsed("repo-a");

    expect(useAppStore.getState().repoCollapsed).toEqual({ "repo-b": true });
    expect("repo-a" in useAppStore.getState().repoCollapsed).toBe(false);
  });
});
