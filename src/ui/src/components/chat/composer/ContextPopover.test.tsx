// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: vi.fn(() => ({
    totalTokens: 5000,
    inputTokens: 4000,
    cacheReadTokens: 500,
    cacheWriteTokens: 500,
  })),
}));

vi.mock("../contextMeterLogic", () => ({
  computeMeterState: vi.fn(() => ({
    totalTokens: 5000,
    capacity: 200000,
    fillPercent: 2.5,
    percentRounded: 3,
  })),
}));

vi.mock("../useSelectedModelEntry", () => ({
  useSelectedModelEntry: vi.fn(() => ({ contextWindowTokens: 200000 })),
}));

vi.mock("./segmentedMeterLogic", () => ({
  segmentedBand: vi.fn(() => "normal"),
  segmentedColor: vi.fn(() => "green"),
  stateLabel: vi.fn(() => "Normal"),
}));

vi.mock("./formatCost", () => ({
  estimateCost: vi.fn(() => 0.05),
  formatCost: vi.fn(() => "$0.05"),
}));

vi.mock("../formatTokens", () => ({
  formatTokens: vi.fn((n: number) => String(n)),
}));

import type { RefObject } from "react";
import { ContextPopover } from "./ContextPopover";

function fireMousedown(target: EventTarget) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
}

describe("ContextPopover", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  describe("click-outside handling with triggerRef", () => {
    it("does not call onClose when mousedown originates from the trigger element", async () => {
      const onClose = vi.fn();
      const triggerEl = document.createElement("button");
      document.body.appendChild(triggerEl);
      const triggerRef = { current: triggerEl } as RefObject<HTMLElement | null>;

      await act(async () => {
        root.render(
          <ContextPopover
            sessionId="s1"
            onClose={onClose}
            onCompact={vi.fn()}
            onClear={vi.fn()}
            triggerRef={triggerRef}
          />,
        );
      });

      fireMousedown(triggerEl);
      expect(onClose).not.toHaveBeenCalled();

      triggerEl.remove();
    });

    it("calls onClose when mousedown originates outside the popover and trigger", async () => {
      const onClose = vi.fn();
      const triggerEl = document.createElement("button");
      const outsideEl = document.createElement("div");
      document.body.appendChild(triggerEl);
      document.body.appendChild(outsideEl);
      const triggerRef = { current: triggerEl } as RefObject<HTMLElement | null>;

      await act(async () => {
        root.render(
          <ContextPopover
            sessionId="s1"
            onClose={onClose}
            onCompact={vi.fn()}
            onClear={vi.fn()}
            triggerRef={triggerRef}
          />,
        );
      });

      fireMousedown(outsideEl);
      expect(onClose).toHaveBeenCalledOnce();

      triggerEl.remove();
      outsideEl.remove();
    });

    it("does not call onClose when mousedown originates inside the popover", async () => {
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <ContextPopover
            sessionId="s1"
            onClose={onClose}
            onCompact={vi.fn()}
            onClear={vi.fn()}
          />,
        );
      });

      fireMousedown(container.firstElementChild!);
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
