import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge before importing the service under test.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// Now import — the mock is in place before `invoke` is captured.
import {
  getWorkspaceEnvSources,
  reloadWorkspaceEnv,
  setEnvProviderEnabled,
} from "./env";

describe("env service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  describe("getWorkspaceEnvSources", () => {
    it("invokes the right command with the workspace id", async () => {
      invokeMock.mockResolvedValueOnce([]);
      await getWorkspaceEnvSources("ws-abc");
      expect(invokeMock).toHaveBeenCalledWith("get_workspace_env_sources", {
        workspaceId: "ws-abc",
      });
    });

    it("returns the backend payload unchanged", async () => {
      const payload = [
        {
          plugin_name: "env-direnv",
          detected: true,
          vars_contributed: 3,
          cached: false,
          evaluated_at_ms: 1_700_000_000_000,
          error: null,
        },
      ];
      invokeMock.mockResolvedValueOnce(payload);
      const result = await getWorkspaceEnvSources("ws-xyz");
      expect(result).toEqual(payload);
    });
  });

  describe("reloadWorkspaceEnv", () => {
    it("passes undefined plugin_name when invalidating everything", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await reloadWorkspaceEnv("ws-1");
      expect(invokeMock).toHaveBeenCalledWith("reload_workspace_env", {
        workspaceId: "ws-1",
        pluginName: undefined,
      });
    });

    it("forwards plugin_name when invalidating a single provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await reloadWorkspaceEnv("ws-2", "env-direnv");
      expect(invokeMock).toHaveBeenCalledWith("reload_workspace_env", {
        workspaceId: "ws-2",
        pluginName: "env-direnv",
      });
    });
  });

  describe("setEnvProviderEnabled", () => {
    it("forwards enabled=true when re-enabling a provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await setEnvProviderEnabled("ws-1", "env-mise", true);
      expect(invokeMock).toHaveBeenCalledWith("set_env_provider_enabled", {
        workspaceId: "ws-1",
        pluginName: "env-mise",
        enabled: true,
      });
    });

    it("forwards enabled=false when disabling a provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await setEnvProviderEnabled("ws-1", "env-mise", false);
      expect(invokeMock).toHaveBeenCalledWith("set_env_provider_enabled", {
        workspaceId: "ws-1",
        pluginName: "env-mise",
        enabled: false,
      });
    });
  });
});
