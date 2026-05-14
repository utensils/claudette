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
      experimentalCodexEnabled: false,
    });
  });

  it("enables backend gates only when the build exposes them", () => {
    useAppStore.getState().setAlternativeBackendsEnabled(true);
    useAppStore.getState().setExperimentalCodexEnabled(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(true);
    expect(useAppStore.getState().experimentalCodexEnabled).toBe(true);

    useAppStore.getState().setAlternativeBackendsAvailable(false);
    expect(useAppStore.getState().alternativeBackendsAvailable).toBe(false);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(false);
    expect(useAppStore.getState().experimentalCodexEnabled).toBe(false);

    useAppStore.getState().setAlternativeBackendsEnabled(true);
    useAppStore.getState().setExperimentalCodexEnabled(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(false);
    expect(useAppStore.getState().experimentalCodexEnabled).toBe(false);
  });

  it("preserves an enabled setting when availability stays true", () => {
    useAppStore.getState().setAlternativeBackendsEnabled(true);
    useAppStore.getState().setAlternativeBackendsAvailable(true);
    expect(useAppStore.getState().alternativeBackendsEnabled).toBe(true);
  });
});
