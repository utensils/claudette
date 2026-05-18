// @vitest-environment happy-dom
//
// Regression coverage for the curated provider list rendering. Pure
// presentation tests — Tauri-side and harness-side logic are covered
// in their own files. Uses react-dom/client directly (no
// @testing-library/react in this repo).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === "string") return options;
      if (options && typeof options === "object") {
        const defaultValue = options.defaultValue;
        if (typeof defaultValue === "string") {
          // Naive {{key}} interpolation, plenty for the assertions
          // below which check that "More providers" / "via auth.json"
          // etc. render. We don't pin exact counts.
          return defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
            const v = options[name];
            return v === undefined ? "" : String(v);
          });
        }
      }
      return key;
    },
  }),
}));

import type { PiProvider } from "../../services/tauri/piProviders";
import { PiProviderList } from "./PiProviderList";

const baseProviders: PiProvider[] = [
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    description: "Sign in once.",
    kind: "oauth+enterprise",
    configured: false,
    modelCount: 26,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "One API key, lots of models.",
    kind: "api_key",
    envHint: "OPENROUTER_API_KEY",
    configured: true,
    authSource: "stored",
    modelCount: 275,
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Direct.",
    kind: "api_key",
    envHint: "OPENAI_API_KEY",
    configured: false,
    modelCount: 42,
  },
  {
    id: "anthropic",
    label: "Anthropic (API)",
    description: "Claude API.",
    kind: "api_key",
    envHint: "ANTHROPIC_API_KEY",
    configured: false,
    modelCount: 23,
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Gemini.",
    kind: "api_key",
    envHint: "GEMINI_API_KEY",
    configured: false,
    modelCount: 27,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "Cheap.",
    kind: "api_key",
    envHint: "DEEPSEEK_API_KEY",
    configured: false,
    modelCount: 2,
  },
  {
    id: "xai",
    label: "xAI",
    description: "Grok.",
    kind: "api_key",
    envHint: "XAI_API_KEY",
    configured: false,
    modelCount: 25,
  },
];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("PiProviderList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderList(onConfigure: (p: PiProvider) => void = () => {}) {
    act(() => {
      root.render(
        <PiProviderList
          providers={baseProviders}
          defaultVisibleCount={6}
          onConfigure={onConfigure}
        />,
      );
    });
  }

  function clickByText(text: string | RegExp) {
    const match = (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[]).find(
      (b) => {
        const t = b.textContent ?? "";
        return typeof text === "string" ? t.includes(text) : text.test(t);
      },
    );
    if (!match) throw new Error(`no button matching ${text}`);
    act(() => match.click());
  }

  it("hides providers beyond defaultVisibleCount behind a disclosure", () => {
    renderList();
    expect(container.textContent).toContain("GitHub Copilot");
    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).not.toContain("xAI");
    expect(container.textContent).toMatch(/More providers/);
  });

  it("expands the full list when the disclosure is clicked", () => {
    renderList();
    clickByText(/More providers/);
    expect(container.textContent).toContain("xAI");
  });

  it("labels configured rows with their auth source", () => {
    renderList();
    // Source rendered as a compact pill alongside the row, not a
    // "via X" sentence anymore. Confirm OpenRouter (the configured
    // fixture) carries the pill text. Pinning the pill node lets a
    // future label change find this assertion.
    const text = container.textContent ?? "";
    expect(text).toContain("auth.json");
  });

  it("uses Sign in / Configure based on provider kind", () => {
    renderList();
    const buttons = Array.from(
      container.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const labels = buttons.map((b) => b.textContent?.trim()).filter(Boolean);
    expect(labels).toContain("Sign in");
    expect(labels).toContain("Configure");
  });

  it("invokes onConfigure with the row's provider when the action is clicked", () => {
    const onConfigure = vi.fn();
    renderList(onConfigure);
    clickByText("Sign in");
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onConfigure.mock.calls[0]?.[0]?.id).toBe("github-copilot");
  });
});
