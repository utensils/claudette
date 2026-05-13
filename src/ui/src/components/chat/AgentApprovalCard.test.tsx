// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentApproval } from "../../stores/useAppStore";
import { AgentApprovalCard } from "./AgentApprovalCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
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

function makeApproval(overrides: Partial<AgentApproval> = {}): AgentApproval {
  return {
    sessionId: "session-1",
    toolUseId: "approval-1",
    kind: "commandExecution",
    details: [{ labelKey: "command", value: "cargo test" }],
    ...overrides,
  };
}

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button ${label} not found`);
  }
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function inputText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

describe("AgentApprovalCard", () => {
  it("omits deny feedback when the approval cannot forward a reason", async () => {
    const onRespond = vi.fn();
    const container = await render(
      <AgentApprovalCard
        approval={makeApproval({ supportsDenyReason: false })}
        onRespond={onRespond}
      />,
    );

    expect(container.querySelector("textarea")).toBeNull();

    await click(buttonNamed(container, "agent_approval_deny"));
    expect(onRespond).toHaveBeenCalledWith(false, undefined);
  });

  it("keeps deny feedback for approvals that support a reason", async () => {
    const onRespond = vi.fn();
    const container = await render(
      <AgentApprovalCard approval={makeApproval()} onRespond={onRespond} />,
    );
    const textarea = container.querySelector("textarea");

    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await inputText(textarea as HTMLTextAreaElement, "not this command");
    await click(buttonNamed(container, "agent_approval_deny"));

    expect(onRespond).toHaveBeenCalledWith(false, "not this command");
  });
});
