// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatEmptyState } from "./ChatEmptyState";

const translations: Record<string, string> = {
  send_message_to_start: "Send a message to start a conversation",
  empty_preparing_env: "Preparing workspace environment…",
  empty_preparing_env_with_plugin: "Preparing {{plugin}} ({{seconds}}s)…",
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

describe("ChatEmptyState", () => {
  it("invites sending when the workspace environment is ready", async () => {
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing={false}
        envPlugin={null}
        envSeconds={null}
      />,
    );

    expect(container.textContent).toBe("Send a message to start a conversation");
  });

  it("explains that env preparation is blocking the first send", async () => {
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing
        envPlugin={null}
        envSeconds={null}
      />,
    );

    expect(container.querySelector("[role='status']")).toBeTruthy();
    expect(container.textContent).toContain("Preparing workspace environment…");
    expect(container.textContent).toContain(
      "You'll be able to send a message in a moment.",
    );
    expect(container.textContent).not.toContain(
      "Send a message to start a conversation",
    );
  });

  it("includes the active env-provider stage when progress is available", async () => {
    const container = await render(
      <ChatEmptyState
        workspaceEnvironmentPreparing
        envPlugin="env-direnv"
        envSeconds={12}
      />,
    );

    expect(container.textContent).toContain("Preparing direnv (12s)…");
  });
});
