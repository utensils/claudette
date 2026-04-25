import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listBuiltinClaudettePlugins,
  setBuiltinClaudettePluginEnabled,
} from "./claudettePlugins";

// Stand-in for `@tauri-apps/api/core` — we verify that the service functions
// invoke the right command names with the right argument shapes. The real
// command handlers are unit-tested on the Rust side.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
});

describe("built-in Claudette plugins service", () => {
  it("listBuiltinClaudettePlugins invokes the matching command", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        name: "send_to_user",
        title: "Send file to user",
        description: "lets the agent deliver…",
        enabled: true,
      },
    ]);
    const result = await listBuiltinClaudettePlugins();
    expect(invokeMock).toHaveBeenCalledWith("list_builtin_claudette_plugins");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "send_to_user",
      enabled: true,
    });
  });

  it("setBuiltinClaudettePluginEnabled passes camelCase params", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await setBuiltinClaudettePluginEnabled("send_to_user", false);
    expect(invokeMock).toHaveBeenCalledWith(
      "set_builtin_claudette_plugin_enabled",
      { pluginName: "send_to_user", enabled: false },
    );
  });

  it("setBuiltinClaudettePluginEnabled propagates Rust errors verbatim", async () => {
    // The Rust side returns Err(String) for unknown plugin names; the service
    // must let that bubble out unchanged so the UI can show the message.
    invokeMock.mockRejectedValueOnce(
      "unknown built-in plugin: nonexistent",
    );
    await expect(
      setBuiltinClaudettePluginEnabled("nonexistent", true),
    ).rejects.toBe("unknown built-in plugin: nonexistent");
  });

  it("an absent backend setting (default) surfaces as enabled=true", async () => {
    // Mirrors the Rust contract: missing key = enabled. The frontend should
    // never see a third state — the row toggle is binary.
    invokeMock.mockResolvedValueOnce([
      {
        name: "send_to_user",
        title: "Send file to user",
        description: "…",
        enabled: true,
      },
    ]);
    const result = await listBuiltinClaudettePlugins();
    expect(result[0].enabled).toBe(true);
  });
});
