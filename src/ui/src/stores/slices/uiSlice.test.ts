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
