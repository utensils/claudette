import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";

const mocks = vi.hoisted(() => ({
  setAppSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/tauri", () => ({
  setAppSetting: mocks.setAppSetting,
}));

const { setPlanModeAndPersist, applyPlanModeMountDefault } = await import(
  "./planModePersistence"
);

const SESSION = "session-123";

beforeEach(() => {
  mocks.setAppSetting.mockClear();
  useAppStore.setState({ planMode: {} });
});

describe("setPlanModeAndPersist", () => {
  it("updates the store and writes the per-session app setting", async () => {
    await setPlanModeAndPersist(SESSION, true);

    expect(useAppStore.getState().planMode[SESSION]).toBe(true);
    expect(mocks.setAppSetting).toHaveBeenCalledTimes(1);
    expect(mocks.setAppSetting).toHaveBeenCalledWith(
      `plan_mode:${SESSION}`,
      "true",
    );
  });

  it("persists the off-state so it survives the next mount", async () => {
    await setPlanModeAndPersist(SESSION, false);

    expect(useAppStore.getState().planMode[SESSION]).toBe(false);
    expect(mocks.setAppSetting).toHaveBeenCalledWith(
      `plan_mode:${SESSION}`,
      "false",
    );
  });
});

describe("applyPlanModeMountDefault", () => {
  it("prefers the persisted per-session value over the global default", () => {
    // Regression for issue 963: a previously persisted "off" must beat
    // `default_plan_mode = true` when the session is first opened in a
    // fresh run.
    applyPlanModeMountDefault(SESSION, "false", true);

    expect(useAppStore.getState().planMode[SESSION]).toBe(false);
  });

  it("uses the persisted 'true' value when present", () => {
    applyPlanModeMountDefault(SESSION, "true", false);

    expect(useAppStore.getState().planMode[SESSION]).toBe(true);
  });

  it("falls back to the global default when no persisted value exists", () => {
    applyPlanModeMountDefault(SESSION, null, true);

    expect(useAppStore.getState().planMode[SESSION]).toBe(true);
  });

  it("falls back to false when neither persisted value nor default is set", () => {
    applyPlanModeMountDefault(SESSION, null, false);

    expect(useAppStore.getState().planMode[SESSION]).toBe(false);
  });

  it("does not clobber a runtime value already in the store", () => {
    // Agent-driven ExitPlanMode set plan mode to false earlier in the run;
    // a remount must not re-apply the global default on top of that.
    useAppStore.setState({ planMode: { [SESSION]: false } });

    applyPlanModeMountDefault(SESSION, "true", true);

    expect(useAppStore.getState().planMode[SESSION]).toBe(false);
  });
});
