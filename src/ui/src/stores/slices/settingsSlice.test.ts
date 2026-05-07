import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";

describe("settingsSlice alternative backend gates", () => {
  beforeEach(() => {
    useAppStore.setState({
      alternativeBackendsAvailable: true,
      alternativeBackendsEnabled: false,
    });
  });

  it("enables alternative backends only when the build exposes them", () => {
    useAppStore.getState().setAlternativeBackendsEnabled(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(true);

    useAppStore.getState().setAlternativeBackendsAvailable(false);
    expect(useAppStore.getState().alternativeBackendsAvailable).toBe(false);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(false);

    useAppStore.getState().setAlternativeBackendsEnabled(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(false);
  });

  it("preserves an enabled setting when availability stays true", () => {
    useAppStore.getState().setAlternativeBackendsEnabled(true);
    useAppStore.getState().setAlternativeBackendsAvailable(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(true);
  });
});
