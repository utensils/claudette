// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(items: ContextMenuItem[], onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ContextMenu x={20} y={20} items={items} onClose={onClose} />,
    );
  });
  return { onClose };
}

/** All `[role="menu"]` boxes currently in the portal (parent + submenu). */
function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="menu"]'));
}

function menuItems(scope: ParentNode = document): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll('[role="menuitem"]'));
}

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots.length = 0;
  document.body.innerHTML = "";
});

describe("ContextMenu", () => {
  it("renders interactive items and skips separators", () => {
    mount([
      { label: "Open", onSelect: vi.fn() },
      { type: "separator" },
      { label: "Delete", onSelect: vi.fn(), variant: "danger" },
    ]);
    const items = menuItems();
    expect(items.map((b) => b.textContent)).toEqual(["Open", "Delete"]);
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it("invokes onSelect and closes on click", async () => {
    const onSelect = vi.fn();
    const { onClose } = mount([{ label: "Open", onSelect }]);
    await act(async () => {
      menuItems()[0].click();
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a header as non-interactive and skipped by menuitem queries", () => {
    mount([
      { type: "header", label: "Claude Code" },
      { label: "Opus 4.7", onSelect: vi.fn() },
    ]);
    const header = document.querySelector('[role="presentation"]');
    expect(header?.textContent).toBe("Claude Code");
    // The header must NOT be a menuitem — keyboard / hover nav skips it.
    expect(menuItems().map((b) => b.textContent)).toEqual(["Opus 4.7"]);
  });

  it("opens a submenu on click and renders its children in a second menu box", async () => {
    const onSelect = vi.fn();
    mount([
      { label: "Open", onSelect: vi.fn() },
      {
        type: "submenu",
        label: "Send to new workspace",
        children: [
          { type: "header", label: "Claude Code" },
          { label: "Opus 4.7", onSelect },
        ],
      },
    ]);
    // Only the parent menu is mounted initially.
    expect(menus()).toHaveLength(1);

    const submenuParent = menuItems().find(
      (b) => b.textContent === "Send to new workspace",
    );
    expect(submenuParent).toBeTruthy();
    expect(submenuParent?.getAttribute("aria-haspopup")).toBe("menu");

    await act(async () => {
      submenuParent?.click();
    });

    // The submenu is a second `[role="menu"]` box in the same portal.
    expect(menus()).toHaveLength(2);
    const submenuLabels = menuItems(menus()[1]).map((b) => b.textContent);
    expect(submenuLabels).toEqual(["Opus 4.7"]);
    // The submenu's header renders too.
    expect(
      menus()[1].querySelector('[role="presentation"]')?.textContent,
    ).toBe("Claude Code");
  });

  it("runs a submenu child's onSelect and closes the whole menu", async () => {
    const onSelect = vi.fn();
    const { onClose } = mount([
      {
        type: "submenu",
        label: "Send to new workspace",
        children: [{ label: "Opus 4.7", onSelect }],
      },
    ]);
    await act(async () => {
      menuItems()
        .find((b) => b.textContent === "Send to new workspace")
        ?.click();
    });
    await act(async () => {
      menuItems(menus()[1])[0].click();
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes the submenu, then the menu, on successive Escape presses", async () => {
    const { onClose } = mount([
      {
        type: "submenu",
        label: "Send to new workspace",
        children: [{ label: "Opus 4.7", onSelect: vi.fn() }],
      },
    ]);
    await act(async () => {
      menuItems()
        .find((b) => b.textContent === "Send to new workspace")
        ?.click();
    });
    expect(menus()).toHaveLength(2);

    // First Escape collapses the submenu only.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(menus()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    // Second Escape closes the whole menu.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables a disabled item so its onSelect never fires", async () => {
    const onSelect = vi.fn();
    mount([{ label: "Open", onSelect, disabled: true }]);
    await act(async () => {
      menuItems()[0].click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
