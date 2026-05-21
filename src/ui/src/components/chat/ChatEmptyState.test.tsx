// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatEmptyState } from "./ChatEmptyState";

const hookMocks = vi.hoisted(() => ({
  useEnvElapsedSeconds: vi.fn<() => { plugin: string | null; seconds: number | null }>(
    () => ({ plugin: null, seconds: null }),
  ),
}));

const translations: Record<string, string> = {
  send_message_to_start: "Send a message to start a conversation",
  empty_preparing_env: "Preparing workspace environment…",
  empty_preparing_env_with_plugin: "Preparing {{plugin}} ({{seconds}}s)…",
  empty_preparing_env_with_plugin_static: "Preparing {{plugin}}…",
  empty_preparing_env_subtitle:
    "You'll be able to send a message in a moment.",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      let value = translations[key] ?? key;
      if (options) {
        for (const [name, replacement] of Object.entries(options)) {
          value = value.replace(`{{${name}}}`, String(replacement));
        }
      }
      return value;
    },
  }),
}));

vi.mock("../../hooks/useEnvElapsedSeconds", () => ({
  useEnvElapsedSeconds: hookMocks.useEnvElapsedSeconds,
}));

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

beforeEach(() => {
  hookMocks.useEnvElapsedSeconds.mockReset();
  hookMocks.useEnvElapsedSeconds.mockReturnValue({
    plugin: null,
    seconds: null,
  });
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
});

describe("ChatEmptyState", () => {
  it("invites sending when the workspace environment is ready", async () => {
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing={false}
        workspaceId="ws-1"
      />,
    );

    expect(container.textContent).toBe("Send a message to start a conversation");
    expect(hookMocks.useEnvElapsedSeconds).toHaveBeenCalledWith(null);
  });

  it("explains that env preparation is blocking the first send", async () => {
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing
        workspaceId="ws-1"
      />,
    );

    expect(container.querySelector("[role='status']")).toBeTruthy();
    expect(container.querySelector("[role='status']")?.getAttribute("aria-label"))
      .toBe("Preparing workspace environment…");
    expect(container.textContent).toContain("Preparing workspace environment…");
    expect(container.textContent).toContain(
      "You'll be able to send a message in a moment.",
    );
    expect(container.textContent).not.toContain(
      "Send a message to start a conversation",
    );
  });

  it("includes the active env-provider stage when progress is available", async () => {
    hookMocks.useEnvElapsedSeconds.mockReturnValueOnce({
      plugin: "env-direnv",
      seconds: 12,
    });
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing
        workspaceId="ws-1"
      />,
    );

    expect(container.textContent).toContain("Preparing direnv (12s)…");
    expect(container.querySelector("[role='status']")?.getAttribute("aria-label"))
      .toBe("Preparing direnv…");
  });
});
