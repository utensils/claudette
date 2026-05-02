// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";
import { useAppStore } from "../../stores/useAppStore";
import {
  fileBufferKey,
  makeUnloadedBuffer,
} from "../../stores/slices/fileTreeSlice";

// Avoid mounting the real Monaco wrapper in tests — it pulls in the
// monaco-editor module which is heavy and has its own DOM expectations.
// We render a simple stub so we can assert on its presence/absence.
vi.mock("./MonacoEditor", () => ({
  MonacoEditor: () => <div data-testid="monaco-editor-stub" />,
}));

// The viewer's load-effect calls `readWorkspaceFileForViewer`; the
// SessionTabs sibling calls `listChatSessions`. Tests seed `loaded: true`
// buffer state in the store so the load-effect short-circuits, and the
// session list isn't asserted on. Use `importOriginal` so we only stub
// the IPC entrypoints that would actually invoke Tauri commands at test
// time.
vi.mock("../../services/tauri", async (importOriginal) => {
  const actual =
    await (importOriginal as () => Promise<typeof import("../../services/tauri")>)();
  return {
    ...actual,
    readWorkspaceFileBytes: vi.fn().mockResolvedValue({
      path: "",
      bytes_b64: "",
      size_bytes: 0,
      truncated: false,
    }),
    readWorkspaceFileForViewer: vi.fn().mockResolvedValue({
      path: "",
      content: "",
      is_binary: false,
      size_bytes: 0,
      truncated: false,
    }),
    writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    listChatSessions: vi.fn().mockResolvedValue([]),
  };
});

import { FileViewer } from "./FileViewer";

const WORKSPACE_ID = "ws-test";
const PATH = "src/bundle.min.js";

function seedBuffer(opts: { sizeBytes: number; buffer?: string }): void {
  const key = fileBufferKey(WORKSPACE_ID, PATH);
  const baseline = opts.buffer ?? "x".repeat(Math.min(opts.sizeBytes, 256));
  useAppStore.setState({
    selectedWorkspaceId: WORKSPACE_ID,
    fileTabsByWorkspace: { [WORKSPACE_ID]: [PATH] },
    activeFileTabByWorkspace: { [WORKSPACE_ID]: PATH },
    fileBuffers: {
      [key]: {
        ...makeUnloadedBuffer(),
        baseline,
        buffer: baseline,
        sizeBytes: opts.sizeBytes,
        loaded: true,
      },
    },
  });
}

describe("FileViewer Monaco render cap", () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedWorkspaceId: null,
      fileTabsByWorkspace: {},
      activeFileTabByWorkspace: {},
      fileBuffers: {},
    });
  });

  afterEach(() => cleanup());

  it("renders Monaco for a small text file", async () => {
    seedBuffer({ sizeBytes: 10_000 });
    const { findByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <FileViewer />
      </I18nextProvider>,
    );
    // findByTestId waits out the lazy-load Suspense boundary.
    expect(await findByTestId("monaco-editor-stub")).toBeTruthy();
  });

  it("falls back to plain-text <pre> for files over 2MB", async () => {
    // 5MB synthetic — well past the 2MB Monaco render cap.
    seedBuffer({ sizeBytes: 5 * 1024 * 1024 });
    const { container, queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <FileViewer />
      </I18nextProvider>,
    );
    // Plain-text <pre> fallback renders synchronously (no Suspense wait).
    // Wait a microtask for any pending state updates to settle.
    await Promise.resolve();
    // Monaco stub MUST NOT be rendered above the cap; the renderer would
    // freeze on a real 5MB minified bundle.
    expect(queryByTestId("monaco-editor-stub")).toBeNull();
    // Plain-text <pre> fallback IS rendered.
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    // Banner explains the fallback.
    const banner = container.textContent ?? "";
    expect(banner).toMatch(/too large|plain text/i);
  });

  it("renders Monaco for a file just under the 2MB cap", async () => {
    // 1.5MB — under the cap, Monaco should still mount.
    seedBuffer({ sizeBytes: 1_500_000 });
    const { findByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <FileViewer />
      </I18nextProvider>,
    );
    expect(await findByTestId("monaco-editor-stub")).toBeTruthy();
  });
});
