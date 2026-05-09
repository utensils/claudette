// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";
import styles from "./ThinkingBlock.module.css";

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
  vi.restoreAllMocks();
});

describe("ThinkingBlock", () => {
  it("defaults to a collapsed bordered disclosure", async () => {
    const container = await render(
      <ThinkingBlock content="private reasoning" isStreaming={false} />,
    );

    expect(container.querySelector(`.${styles.container}`)).toBeTruthy();
    expect(container.querySelector(`.${styles.containerInline}`)).toBeNull();
    expect(container.querySelector('[aria-expanded="false"]')).toBeTruthy();
    expect(container.textContent).not.toContain("private reasoning");
  });

  it("renders expanded and unbordered in inline mode", async () => {
    const container = await render(
      <ThinkingBlock content="private reasoning" isStreaming={false} inline />,
    );

    expect(container.querySelector(`.${styles.containerInline}`)).toBeTruthy();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("private reasoning");
  });

  it("does not start the typewriter loop when typewriter mode is omitted", async () => {
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame");

    await render(
      <ThinkingBlock content="private reasoning" isStreaming={false} inline />,
    );

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
