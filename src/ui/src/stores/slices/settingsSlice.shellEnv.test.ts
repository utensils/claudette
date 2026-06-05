import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../useAppStore";
import * as envService from "../../services/env";

describe("settingsSlice — shell env slice", () => {
  beforeEach(() => {
    useAppStore.setState({ shellEnv: null });
    vi.restoreAllMocks();
  });

  it("hydrates from list_shell_env", async () => {
    vi.spyOn(envService, "listShellEnv").mockResolvedValue({
      captured_at_ms: 1_700_000_000_000,
      forwarded: [{ name: "JWT_CLIENT_ID", value: "abc", denied: false }],
      inherited: [],
      denied_built_in: ["LD_PRELOAD"],
      denied_user: [],
      disabled: false,
      source_files: ["/Users/k/.zshrc"],
      error: null,
    });
    await useAppStore.getState().refreshShellEnv();
    const snap = useAppStore.getState().shellEnv;
    expect(snap?.forwarded[0]?.name).toBe("JWT_CLIENT_ID");
    expect(snap?.disabled).toBe(false);
  });

  it("setShellEnvDenylist forwards to the service and refreshes", async () => {
    const setSpy = vi
      .spyOn(envService, "setShellEnvDenylist")
      .mockResolvedValue(undefined);
    const listSpy = vi.spyOn(envService, "listShellEnv").mockResolvedValue({
      captured_at_ms: 0,
      forwarded: [],
      inherited: [],
      denied_built_in: [],
      denied_user: ["AWS_*"],
      disabled: false,
      source_files: [],
      error: null,
    });
    await useAppStore.getState().setShellEnvDenylist(["AWS_*"]);
    expect(setSpy).toHaveBeenCalledWith(["AWS_*"]);
    expect(listSpy).toHaveBeenCalled();
  });
});
