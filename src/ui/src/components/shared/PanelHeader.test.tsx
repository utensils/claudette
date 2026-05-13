// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import { PanelHeader } from "./PanelHeader";
import styles from "./PanelHeader.module.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function renderPanelHeader(props: {
  left?: React.ReactNode;
  right?: React.ReactNode;
} = {}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <PanelHeader
        left={props.left ?? <span>Dashboard</span>}
        right={props.right}
      />,
    );
  });
  return container;
}

describe("PanelHeader", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useAppStore.setState({ sidebarVisible: true });
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0).reverse()) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove();
    }
    vi.clearAllMocks();
  });

  it("renders the root as a Tauri drag region", async () => {
    const container = await renderPanelHeader();
    const header = container.querySelector(`.${styles.header}`);

    expect(header).toBeTruthy();
    expect(header?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("renders the non-selectable left slot wrapper", async () => {
    const container = await renderPanelHeader({ left: <span>Project title</span> });
    const left = container.querySelector(`.${styles.headerLeft}`);
    const css = readFileSync(resolve(__dirname, "PanelHeader.module.css"), "utf8");

    expect(left).toBeTruthy();
    expect(left?.textContent).toBe("Project title");
    expect(css).toMatch(/\.headerLeft\s*\{[^}]*user-select:\s*none/s);
  });

  it("renders the right slot only when provided", async () => {
    const withoutRight = await renderPanelHeader();
    expect(withoutRight.querySelector(`.${styles.headerRight}`)).toBeNull();

    const withRight = await renderPanelHeader({
      right: <button type="button">Toggle</button>,
    });
    const right = withRight.querySelector(`.${styles.headerRight}`);
    expect(right).toBeTruthy();
    expect(right?.textContent).toBe("Toggle");
  });

  it("applies the no-sidebar padding variant when the sidebar is hidden", async () => {
    useAppStore.setState({ sidebarVisible: false });

    const container = await renderPanelHeader();
    const header = container.querySelector(`.${styles.header}`);

    expect(header?.classList.contains(styles.noSidebar)).toBe(true);
  });
});
