// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { editor as MonacoNs } from "monaco-editor";

// React 19 emits "current testing environment is not configured to support
// act(...)" without this flag — see react-dom/test docs.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface MenubarStoreShape {
  keybindings: Record<string, string | null>;
  editorWordWrap: boolean;
  editorMinimapEnabled: boolean;
  editorLineNumbersEnabled: boolean;
  editorFontZoom: number;
  rightSidebarVisible: boolean;
  workspaces: Array<{ id: string; worktree_path: string | null }>;
  fileBuffers: Record<string, unknown>;
  setFileBufferContent: ReturnType<typeof vi.fn>;
  setAllFilesSelectedPath: ReturnType<typeof vi.fn>;
  setAllFilesDirExpanded: ReturnType<typeof vi.fn>;
  toggleRightSidebar: ReturnType<typeof vi.fn>;
  setRightSidebarTab: ReturnType<typeof vi.fn>;
  openCommandPaletteFileMode: ReturnType<typeof vi.fn>;
  setEditorWordWrap: ReturnType<typeof vi.fn>;
  setEditorMinimapEnabled: ReturnType<typeof vi.fn>;
  setEditorLineNumbersEnabled: ReturnType<typeof vi.fn>;
  setEditorFontZoom: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
}

const store = vi.hoisted(
  (): MenubarStoreShape => ({
    keybindings: {},
    editorWordWrap: true,
    editorMinimapEnabled: false,
    editorLineNumbersEnabled: true,
    editorFontZoom: 1,
    rightSidebarVisible: false,
    workspaces: [{ id: "ws-1", worktree_path: "/repo/worktree" }],
    fileBuffers: {},
    setFileBufferContent: vi.fn(),
    setAllFilesSelectedPath: vi.fn(),
    setAllFilesDirExpanded: vi.fn(),
    toggleRightSidebar: vi.fn(),
    setRightSidebarTab: vi.fn(),
    openCommandPaletteFileMode: vi.fn(),
    setEditorWordWrap: vi.fn(),
    setEditorMinimapEnabled: vi.fn(),
    setEditorLineNumbersEnabled: vi.fn(),
    setEditorFontZoom: vi.fn(),
    addToast: vi.fn(),
  }),
);

const setAppSettingMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../../../stores/useAppStore", () => {
  const useAppStore = <T,>(selector: (state: MenubarStoreShape) => T): T =>
    selector(store);
  (useAppStore as unknown as { getState: () => MenubarStoreShape }).getState =
    () => store;
  return { useAppStore };
});

vi.mock("../../../services/tauri", () => ({
  setAppSetting: setAppSettingMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const contextMenuMock = vi.hoisted(() => ({ lastProps: null as unknown }));

vi.mock("../../shared/ContextMenu", () => ({
  ContextMenu: (props: unknown) => {
    contextMenuMock.lastProps = props;
    return null;
  },
}));

vi.mock("../../../hotkeys/platform", () => ({
  isMacHotkeyPlatform: () => true,
  getHotkeyPlatform: () => "mac",
}));

import { EditorMenubar } from "./EditorMenubar";

interface CtxMenuProps {
  x: number;
  y: number;
  items: Array<
    | { type: "separator" }
    | { label: string; shortcut?: string; disabled?: boolean; onSelect: () => void }
  >;
  onClose: () => void;
  dataTestId?: string;
}

function lastCtxProps(): CtxMenuProps | null {
  return contextMenuMock.lastProps as CtxMenuProps | null;
}

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

interface HarnessProps {
  dirty?: boolean;
  canEdit?: boolean;
  onSave?: () => void;
  onCloseTab?: () => void;
}

function Harness(props: HarnessProps) {
  const editorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
  return (
    <EditorMenubar
      workspaceId="ws-1"
      path="src/components/Foo.tsx"
      dirty={props.dirty ?? false}
      canEdit={props.canEdit ?? true}
      editorRef={editorRef}
      onSave={props.onSave ?? vi.fn()}
      onCloseTab={props.onCloseTab ?? vi.fn()}
    />
  );
}

async function mount(props: HarnessProps = {}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  return container;
}

async function clickTrigger(container: HTMLElement, menuId: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-menu-id="${menuId}"]`,
  );
  if (!button) throw new Error(`missing trigger ${menuId}`);
  await act(async () => {
    button.click();
  });
  return button;
}

async function hoverTrigger(container: HTMLElement, menuId: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-menu-id="${menuId}"]`,
  );
  if (!button) throw new Error(`missing trigger ${menuId}`);
  // React's onMouseEnter is computed from delegated mouseover events
  // (mouseenter itself doesn't bubble), so dispatching a bubbling
  // mouseover with relatedTarget=null triggers the handler under happy-dom.
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }),
    );
  });
}

describe("EditorMenubar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    contextMenuMock.lastProps = null;
    setAppSettingMock.mockClear();
    Object.values(store)
      .filter((v): v is ReturnType<typeof vi.fn> =>
        typeof v === "function" && "mockClear" in v,
      )
      .forEach((m) => m.mockClear());
    store.editorWordWrap = true;
    store.editorMinimapEnabled = false;
    store.editorLineNumbersEnabled = true;
    store.editorFontZoom = 1;
    store.rightSidebarVisible = false;
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

  it("renders the four canonical menu triggers", async () => {
    const container = await mount();
    const ids = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-menu-id]"),
    ).map((el) => el.dataset.menuId);
    expect(ids).toEqual(["file", "edit", "view", "go"]);
  });

  it("starts with no dropdown open and aria-expanded=false on all triggers", async () => {
    const container = await mount();
    expect(lastCtxProps()).toBeNull();
    const triggers = container.querySelectorAll<HTMLButtonElement>(
      "[data-menu-id]",
    );
    triggers.forEach((el) =>
      expect(el.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("opens the File menu when its trigger is clicked, with dropdown items mapped", async () => {
    const container = await mount({ dirty: true });
    await clickTrigger(container, "file");

    const props = lastCtxProps();
    expect(props).not.toBeNull();
    const labels = props!.items
      .filter((i): i is Extract<typeof i, { label: string }> => "label" in i)
      .map((i) => i.label);
    expect(labels).toContain("editor_menu_file_save");
    expect(labels).toContain("editor_menu_file_revert");
    expect(labels).toContain("editor_menu_file_reveal_in_files");
    expect(labels).toContain("editor_menu_file_close");
    expect(
      container
        .querySelector('[data-menu-id="file"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("clicking the same trigger twice toggles the dropdown closed", async () => {
    const container = await mount();
    await clickTrigger(container, "edit");
    expect(lastCtxProps()).not.toBeNull();
    // Toggle closed
    contextMenuMock.lastProps = null;
    await clickTrigger(container, "edit");
    // Component re-renders without ContextMenu (lastProps stays null because
    // the mocked component is never invoked when activeMenu is null).
    expect(lastCtxProps()).toBeNull();
  });

  it("swaps menus on hover when one is already open", async () => {
    const container = await mount();
    await clickTrigger(container, "file");
    const before = lastCtxProps()!;
    expect(before.items.some((i) => "label" in i && i.label === "editor_menu_file_save")).toBe(
      true,
    );

    await hoverTrigger(container, "view");
    const after = lastCtxProps()!;
    expect(
      after.items.some(
        (i) => "label" in i && i.label.startsWith("editor_menu_view_"),
      ),
    ).toBe(true);
  });

  it("does NOT open a menu on hover when none is open", async () => {
    const container = await mount();
    await hoverTrigger(container, "view");
    expect(lastCtxProps()).toBeNull();
  });

  it("disables Save in the File dropdown when the buffer is clean", async () => {
    const container = await mount({ dirty: false });
    await clickTrigger(container, "file");
    const save = lastCtxProps()!.items.find(
      (i) => "label" in i && i.label === "editor_menu_file_save",
    );
    expect(save).toBeDefined();
    expect("disabled" in save! && save.disabled).toBe(true);
  });

  it("disables editor-mutation items when canEdit is false", async () => {
    const container = await mount({ canEdit: false });
    await clickTrigger(container, "edit");
    const items = lastCtxProps()!.items;
    const find = items.find((i) => "label" in i && i.label === "editor_menu_edit_find");
    const copyPath = items.find(
      (i) => "label" in i && i.label === "editor_menu_edit_copy_path",
    );
    expect("disabled" in find! && find.disabled).toBe(true);
    expect("disabled" in copyPath! && copyPath.disabled).toBeFalsy();
  });

  it("View > Toggle Word Wrap fires the store setter + persists", async () => {
    const container = await mount();
    await clickTrigger(container, "view");
    const item = lastCtxProps()!.items.find(
      (i) =>
        "label" in i &&
        (i.label === "editor_menu_view_word_wrap_off" ||
          i.label === "editor_menu_view_word_wrap_on"),
    ) as { onSelect: () => void };
    await act(async () => {
      item.onSelect();
    });
    expect(store.setEditorWordWrap).toHaveBeenCalledWith(false);
    expect(setAppSettingMock).toHaveBeenCalledWith("editor_word_wrap", "false");
  });

  it("Go > Go to File opens the command palette in file mode", async () => {
    const container = await mount();
    await clickTrigger(container, "go");
    const item = lastCtxProps()!.items.find(
      (i) => "label" in i && i.label === "editor_menu_go_to_file",
    ) as { onSelect: () => void };
    await act(async () => {
      item.onSelect();
    });
    expect(store.openCommandPaletteFileMode).toHaveBeenCalledTimes(1);
  });
});
