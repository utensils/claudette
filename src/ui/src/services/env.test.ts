import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  envTargetFromRepo,
  envTargetFromWorkspace,
  getEnvSources,
  reloadEnv,
  runEnvTrust,
  setEnvProviderEnabled,
} from "./env";

describe("env service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  describe("envTargetFromRepo / envTargetFromWorkspace", () => {
    it("constructs kind=repo targets", () => {
      expect(envTargetFromRepo("r-1")).toEqual({ kind: "repo", repo_id: "r-1" });
    });

    it("constructs kind=workspace targets", () => {
      expect(envTargetFromWorkspace("w-1")).toEqual({
        kind: "workspace",
        workspace_id: "w-1",
      });
    });
  });

  describe("getEnvSources", () => {
    it("invokes with a repo target", async () => {
      invokeMock.mockResolvedValueOnce([]);
      await getEnvSources({ kind: "repo", repo_id: "r-1" });
      expect(invokeMock).toHaveBeenCalledWith("get_env_sources", {
        target: { kind: "repo", repo_id: "r-1" },
      });
    });

    it("invokes with a workspace target", async () => {
      invokeMock.mockResolvedValueOnce([]);
      await getEnvSources({ kind: "workspace", workspace_id: "w-1" });
      expect(invokeMock).toHaveBeenCalledWith("get_env_sources", {
        target: { kind: "workspace", workspace_id: "w-1" },
      });
    });

    it("returns the backend payload unchanged", async () => {
      const payload = [
        {
          plugin_name: "env-direnv",
          display_name: "direnv",
          detected: true,
          enabled: true,
          vars_contributed: 3,
          cached: false,
          evaluated_at_ms: 1_700_000_000_000,
          error: null,
        },
      ];
      invokeMock.mockResolvedValueOnce(payload);
      const result = await getEnvSources({ kind: "repo", repo_id: "r-1" });
      expect(result).toEqual(payload);
    });
  });

  describe("reloadEnv", () => {
    it("passes undefined plugin_name when invalidating everything", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await reloadEnv({ kind: "workspace", workspace_id: "w-1" });
      expect(invokeMock).toHaveBeenCalledWith("reload_env", {
        target: { kind: "workspace", workspace_id: "w-1" },
        pluginName: undefined,
      });
    });

    it("forwards plugin_name when invalidating a single provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await reloadEnv({ kind: "repo", repo_id: "r-1" }, "env-direnv");
      expect(invokeMock).toHaveBeenCalledWith("reload_env", {
        target: { kind: "repo", repo_id: "r-1" },
        pluginName: "env-direnv",
      });
    });
  });

  describe("setEnvProviderEnabled", () => {
    it("forwards enabled=true when re-enabling a provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await setEnvProviderEnabled(
        { kind: "repo", repo_id: "r-1" },
        "env-mise",
        true,
      );
      expect(invokeMock).toHaveBeenCalledWith("set_env_provider_enabled", {
        target: { kind: "repo", repo_id: "r-1" },
        pluginName: "env-mise",
        enabled: true,
      });
    });

    it("forwards enabled=false when disabling a provider", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await setEnvProviderEnabled(
        { kind: "workspace", workspace_id: "w-1" },
        "env-mise",
        false,
      );
      expect(invokeMock).toHaveBeenCalledWith("set_env_provider_enabled", {
        target: { kind: "workspace", workspace_id: "w-1" },
        pluginName: "env-mise",
        enabled: false,
      });
    });
  });

  describe("runEnvTrust", () => {
    it("invokes run_env_trust for env-direnv", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await runEnvTrust({ kind: "repo", repo_id: "r-1" }, "env-direnv");
      expect(invokeMock).toHaveBeenCalledWith("run_env_trust", {
        target: { kind: "repo", repo_id: "r-1" },
        pluginName: "env-direnv",
      });
    });

    it("invokes run_env_trust for env-mise", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await runEnvTrust(
        { kind: "workspace", workspace_id: "w-1" },
        "env-mise",
      );
      expect(invokeMock).toHaveBeenCalledWith("run_env_trust", {
        target: { kind: "workspace", workspace_id: "w-1" },
        pluginName: "env-mise",
      });
    });
  });
});
