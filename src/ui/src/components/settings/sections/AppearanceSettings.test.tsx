// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import styles from "../Settings.module.css";
import { ToolGroupingDescription } from "./AppearanceSettings";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("ToolGroupingDescription", () => {
  it("adds Brink Mode with Brink highlighted as a settings badge", async () => {
    const container = await render(
      <ToolGroupingDescription description="Collapse adjacent regular tool calls into summary blocks. Turn off to show every top-level tool call, Agent call, and thinking block inline." />,
    );

    expect(container.textContent).toBe(
      "Collapse adjacent regular tool calls into summary blocks. Turn off to show every top-level tool call, Agent call, and thinking block inline. (Brink Mode)",
    );

    const badge = container.querySelector(
      `.${styles.settingDescriptionBadge}`,
    );
    expect(badge?.textContent).toBe("Brink");
  });
});
