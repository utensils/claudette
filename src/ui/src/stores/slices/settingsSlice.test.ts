import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";

describe("settingsSlice appearance defaults", () => {
  beforeEach(() => {
    useAppStore.setState({ extendedToolCallOutput: false });
  });

  it("keeps extended tool call output disabled by default", () => {
    expect(useAppStore.getState().extendedToolCallOutput).toBe(false);
  });

  it("toggles extended tool call output explicitly", () => {
    useAppStore.getState().setExtendedToolCallOutput(true);
    expect(useAppStore.getState().extendedToolCallOutput).toBe(true);

    useAppStore.getState().setExtendedToolCallOutput(false);
    expect(useAppStore.getState().extendedToolCallOutput).toBe(false);
  });
});

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
