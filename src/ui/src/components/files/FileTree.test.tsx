// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";
import { FileTree } from "./FileTree";
import { useAppStore } from "../../stores/useAppStore";
import type { FileEntry } from "../../services/tauri";

/** Build N synthetic file entries spread across nested directories so the
 *  flattened-visible list has size on the order of `count`. The exact
 *  structure isn't important — we just want a realistic-shaped tree
 *  whose visible row count is dominated by file rows. */
function makeEntries(count: number): FileEntry[] {
  const out: FileEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ path: `src/dir-${i % 50}/file-${i}.ts`, is_directory: false });
  }
  return out;
}

/** Expand every directory in the tree so the visible-row count equals
 *  the total number of nodes. Forces virtualization to do real work
 *  instead of hiding behind collapsed dirs. */
function expandAll(workspaceId: string, entries: FileEntry[]): void {
  const dirs = new Set<string>();
  for (const e of entries) {
    let pos = 0;
    while ((pos = e.path.indexOf("/", pos)) !== -1) {
      dirs.add(e.path.slice(0, pos + 1));
      pos += 1;
    }
  }
  for (const d of dirs) {
    useAppStore.getState().setAllFilesDirExpanded(workspaceId, d, true);
  }
}

describe("FileTree", () => {
  const workspaceId = "ws-test";

  // Originals are captured once and restored after each test so the
  // happy-dom prototype mutations below don't leak into other test files
  // sharing this environment. `clientHeight` is a property descriptor;
  // `getBoundingClientRect` is a method.
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    // Reset per-workspace tree state so prior test cases don't smear
    // expansion/selection into later ones.
    useAppStore.setState({
      allFilesExpandedDirsByWorkspace: {},
      allFilesSelectedPathByWorkspace: {},
    });
    // happy-dom doesn't compute layout, so element clientHeight defaults
    // to 0 and the virtualizer renders zero rows. Stub a viewport size
    // large enough to render a realistic number of rows so the bounded
    // DOM assertion is meaningful (otherwise we'd be asserting "<500"
    // against zero, which would pass even for a non-virtualized
    // implementation rendering nothing).
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 600;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 600,
        width: 320,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  afterEach(() => {
    cleanup();
    // Restore originals so other test files in the same happy-dom
    // environment aren't affected by our stubs.
    if (originalClientHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientHeight",
        originalClientHeight,
      );
    } else {
      // happy-dom didn't have an own descriptor for clientHeight before
      // we stubbed it — delete the stub to drop back to the inherited
      // getter (returns 0).
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .clientHeight;
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it("renders with 100 entries", () => {
    const entries = makeEntries(100);
    expandAll(workspaceId, entries);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <FileTree
          workspaceId={workspaceId}
          entries={entries}
          onActivateFile={() => {}}
        />
      </I18nextProvider>,
    );
    // Tree container exists.
    expect(container.querySelector('[role="tree"]')).toBeTruthy();
    // The virtualizer-sized inner container should have a non-zero height
    // matching the full virtual list (we can't easily assert exact rows
    // since happy-dom's layout is stubbed; assert the inner wrapper sized
    // itself, which proves the virtualizer ran and has rows to show).
    const inner = container.querySelector(
      '[role="tree"] > div',
    ) as HTMLElement | null;
    expect(inner).toBeTruthy();
    expect(parseInt(inner!.style.height, 10)).toBeGreaterThan(0);
  });

  it("renders with 1000 entries without flooding the DOM", () => {
    const entries = makeEntries(1000);
    expandAll(workspaceId, entries);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <FileTree
          workspaceId={workspaceId}
          entries={entries}
          onActivateFile={() => {}}
        />
      </I18nextProvider>,
    );
    // Virtualization cap: even at 1000 visible rows the DOM should hold
    // far fewer than the full set. happy-dom reports zero scroll height
    // by default, so the virtualizer falls back to its overscan window.
    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows.length).toBeLessThan(500);
  });

  it("keeps DOM bounded at 50_000 entries", () => {
    const entries = makeEntries(50_000);
    expandAll(workspaceId, entries);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <FileTree
          workspaceId={workspaceId}
          entries={entries}
          onActivateFile={() => {}}
        />
      </I18nextProvider>,
    );
    // Acceptance criterion from issue 583: DOM stays <500 even at 50k.
    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows.length).toBeLessThan(500);
  });
});
