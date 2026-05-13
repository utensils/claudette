// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceFileIndex } from "./useWorkspaceFileIndex";
import { useAppStore } from "../../stores/useAppStore";

const serviceMocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({
  listWorkspaceFiles: serviceMocks.listWorkspaceFiles,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];
let latestResolve: ((path: string) => string | null) | null = null;

function Harness({ workspaceId }: { workspaceId: string }) {
  const index = useWorkspaceFileIndex(workspaceId);
  useEffect(() => {
    latestResolve = index.resolve;
  }, [index.resolve]);
  return null;
}

async function render(workspaceId: string): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(<Harness workspaceId={workspaceId} />);
  });
}

beforeEach(() => {
  latestResolve = null;
  serviceMocks.listWorkspaceFiles.mockReset();
  serviceMocks.listWorkspaceFiles.mockResolvedValue([
    { path: "Cargo.toml", is_directory: false },
    { path: "README.md", is_directory: false },
    { path: "src/main.rs", is_directory: false },
    { path: "examples/main.rs", is_directory: false },
    { path: "src", is_directory: true },
  ]);
  useAppStore.setState({ fileTreeRefreshNonceByWorkspace: {} });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
});

describe("useWorkspaceFileIndex", () => {
  it("resolves exact paths and unique basenames with one workspace file load", async () => {
    await render("ws-a");
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(latestResolve?.("Cargo.toml")).toBe("Cargo.toml");
    expect(latestResolve?.("./README.md")).toBe("README.md");
    expect(latestResolve?.("src/main.rs")).toBe("src/main.rs");
    expect(latestResolve?.("./README.md:7")).toBe("README.md:7");
    expect(latestResolve?.("Cargo.toml:2:3-4:5")).toBe("Cargo.toml:2:3-4:5");
    expect(latestResolve?.("main.rs")).toBeNull();
    expect(latestResolve?.("src")).toBeNull();
  });

  it("shares the cached load across multiple consumers for the same workspace", async () => {
    await render("ws-b");
    await render("ws-b");
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.listWorkspaceFiles).toHaveBeenCalledTimes(1);
  });
});
