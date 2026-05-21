// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { workspaceRefreshPollingAllowed } from "./pollingIntervals";

describe("workspaceRefreshPollingAllowed", () => {
  it("allows polling while the document is visible", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    expect(workspaceRefreshPollingAllowed()).toBe(true);
  });

  it("blocks polling while the document is hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    expect(workspaceRefreshPollingAllowed()).toBe(false);
  });
});
