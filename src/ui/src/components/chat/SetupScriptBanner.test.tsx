// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// CopyButton pulls in clipboard plumbing we don't need here — stub it to a
// plain marker so the banner's own structure is what we assert against.
vi.mock("../shared/CopyButton", () => ({
  CopyButton: () => <button data-testid="copy-button">copy</button>,
}));

import { SetupScriptBanner } from "./SetupScriptBanner";
import type { SetupScriptOutcome } from "../../utils/setupScriptMessage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(
  outcome: SetupScriptOutcome,
  messageId = "msg-1",
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<SetupScriptBanner outcome={outcome} messageId={messageId} />);
  });
  return container;
}

function banner(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-testid='setup-script-banner']") as HTMLElement;
}

describe("SetupScriptBanner", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      mountedRoots.forEach((r) => r.unmount());
    });
    mountedContainers.forEach((c) => c.remove());
    mountedRoots.length = 0;
    mountedContainers.length = 0;
  });

  it("renders a completed run collapsed (no output body, no toggle button)", async () => {
    const container = await render({
      source: "settings",
      status: "completed",
      output: "Resolved 1657 packages\ndone",
    });
    expect(banner(container).dataset.status).toBe("completed");
    // No <pre> shown while collapsed.
    expect(container.querySelector("pre")).toBeNull();
    // The toggle button exists (there is output to reveal) but the body is hidden.
    const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("auto-expands a failed run and surfaces the output", async () => {
    const container = await render({
      source: "settings",
      status: "failed",
      output: "npm ERR! something broke",
    });
    const b = banner(container);
    expect(b.dataset.status).toBe("failed");
    // Danger class is applied so the chip stays noticeable.
    expect(b.className).toMatch(/failed/);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("npm ERR! something broke");
    const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggling persists the choice to sessionStorage", async () => {
    const container = await render(
      { source: "settings", status: "completed", output: "lots of logs" },
      "msg-toggle",
    );
    const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    expect(container.querySelector("pre")?.textContent).toBe("lots of logs");
    expect(sessionStorage.getItem("claudette.setupScriptBanner.expanded:msg-toggle")).toBe("1");
    await act(async () => {
      (container.querySelector("button[aria-expanded]") as HTMLButtonElement).click();
    });
    expect(container.querySelector("pre")).toBeNull();
    expect(sessionStorage.getItem("claudette.setupScriptBanner.expanded:msg-toggle")).toBe("0");
  });

  it("a stored collapse choice overrides the failure default", async () => {
    sessionStorage.setItem("claudette.setupScriptBanner.expanded:msg-stored", "0");
    const container = await render(
      { source: "settings", status: "failed", output: "broke" },
      "msg-stored",
    );
    const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders a static chip with no toggle or copy button when output is empty", async () => {
    const container = await render({ source: "settings", status: "completed", output: "" });
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.querySelector("[data-testid='copy-button']")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    // The summary is still present.
    expect(container.textContent).toContain("setup_script_label");
  });

  it("shows a copy button only when there is output", async () => {
    const withOutput = await render(
      { source: "settings", status: "completed", output: "x" },
      "msg-copy-1",
    );
    expect(withOutput.querySelector("[data-testid='copy-button']")).not.toBeNull();
  });
});
