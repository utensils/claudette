// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentQuestion } from "../../stores/useAppStore";
import { AgentQuestionCard } from "./AgentQuestionCard";

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

describe("AgentQuestionCard", () => {
  it("immediately marks single-question multi-select options as pressed", async () => {
    const question: AgentQuestion = {
      sessionId: "s1",
      toolUseId: "tool1",
      questions: [
        {
          question: "Pick targets",
          multiSelect: true,
          options: [{ label: "Unit" }, { label: "Integration" }],
        },
      ],
    };

    const container = await render(
      <AgentQuestionCard question={question} onRespond={vi.fn()} />,
    );
    const unit = buttonNamed(container, "Unit");

    expect(unit.getAttribute("aria-pressed")).toBe("false");
    await click(unit);
    expect(unit.getAttribute("aria-pressed")).toBe("true");
    await click(unit);
    expect(unit.getAttribute("aria-pressed")).toBe("false");
  });

  it("immediately marks multi-question wizard multi-select options as pressed", async () => {
    const question: AgentQuestion = {
      sessionId: "s1",
      toolUseId: "tool1",
      questions: [
        {
          question: "Pick checks",
          multiSelect: true,
          options: [{ label: "Lint" }, { label: "Typecheck" }],
        },
        {
          question: "Ship it?",
          options: [{ label: "Yes" }],
        },
      ],
    };

    const container = await render(
      <AgentQuestionCard question={question} onRespond={vi.fn()} />,
    );
    const lint = buttonNamed(container, "Lint");

    expect(lint.getAttribute("aria-pressed")).toBe("false");
    await click(lint);
    expect(lint.getAttribute("aria-pressed")).toBe("true");
    await click(lint);
    expect(lint.getAttribute("aria-pressed")).toBe("false");
  });
});
