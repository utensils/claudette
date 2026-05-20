// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import {
  fileBufferKey,
  makeUnloadedBuffer,
} from "../../stores/slices/fileTreeSlice";
import { FileViewer } from "./FileViewer";

const serviceMocks = vi.hoisted(() => ({
  loadDiffFiles: vi.fn(),
  readAgentManagedFile: vi.fn(),
  readWorkspaceFileBytes: vi.fn(),
  readWorkspaceFileForViewer: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

vi.mock("../../services/tauri", () => serviceMocks);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../chat/SessionTabs", () => ({
  SessionTabs: () => <div data-testid="session-tabs" />,
}));
vi.mock("./MonacoEditor", () => ({
  MonacoEditor: () => <div data-testid="monaco-editor" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WS = "workspace-1";
const FILE = "README.md";

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

function seedOpenFile(closeNonce = 0) {
  useAppStore.setState({
    selectedWorkspaceId: WS,
    fileTabsByWorkspace: { [WS]: [FILE] },
    activeFileTabByWorkspace: { [WS]: FILE },
    fileRevealTargetByWorkspace: {},
    fileBuffers: {
      [fileBufferKey(WS, FILE)]: makeUnloadedBuffer(),
    },
    requestCloseFileTabNonceByWorkspace: { [WS]: closeNonce },
  });
}

beforeEach(() => {
  serviceMocks.loadDiffFiles.mockReset();
  serviceMocks.readAgentManagedFile.mockReset();
  serviceMocks.readWorkspaceFileBytes.mockReset();
  serviceMocks.readWorkspaceFileForViewer.mockReset();
  serviceMocks.writeWorkspaceFile.mockReset();
  serviceMocks.readWorkspaceFileForViewer.mockResolvedValue({
    content: "# README",
    is_binary: false,
    size_bytes: 8,
    truncated: false,
  });
  useAppStore.setState({
    selectedWorkspaceId: null,
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileRevealTargetByWorkspace: {},
    fileBuffers: {},
    requestCloseFileTabNonceByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
  vi.restoreAllMocks();
});

describe("FileViewer close nonce handling", () => {
  it("does not consume a stale close nonce when reopening a file tab", async () => {
    seedOpenFile(1);

    await render(<FileViewer />);
    await act(async () => {
      await Promise.resolve();
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual([FILE]);
    expect(state.activeFileTabByWorkspace[WS]).toBe(FILE);
  });

  it("closes the mounted file when the close nonce increments", async () => {
    seedOpenFile(1);

    await render(<FileViewer />);
    await act(async () => {
      useAppStore.setState({
        requestCloseFileTabNonceByWorkspace: { [WS]: 2 },
      });
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual([]);
    expect(state.activeFileTabByWorkspace[WS]).toBeNull();
  });
});

describe("FileViewer agent-managed files", () => {
  const AGENT_FILE = "/Users/test/.claude/plans/sunny-otter.md";

  function seedOpenAgentFile() {
    useAppStore.setState({
      selectedWorkspaceId: WS,
      fileTabsByWorkspace: { [WS]: [AGENT_FILE] },
      activeFileTabByWorkspace: { [WS]: AGENT_FILE },
      fileRevealTargetByWorkspace: {},
      fileBuffers: {
        [fileBufferKey(WS, AGENT_FILE)]: makeUnloadedBuffer(),
      },
      requestCloseFileTabNonceByWorkspace: { [WS]: 0 },
    });
  }

  it("loads an agent-managed file via the allow-listed route", async () => {
    serviceMocks.readAgentManagedFile.mockResolvedValue({
      path: AGENT_FILE,
      content: "# Plan",
      is_binary: false,
      size_bytes: 6,
      truncated: false,
      is_symlink: false,
    });
    seedOpenAgentFile();

    const container = await render(<FileViewer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Routed to the agent-file command, not the worktree file reader.
    expect(serviceMocks.readAgentManagedFile).toHaveBeenCalledWith(AGENT_FILE);
    expect(serviceMocks.readWorkspaceFileForViewer).not.toHaveBeenCalled();

    // Buffer loaded; the kind badge is rendered (mocked t() echoes the key).
    const buffer = useAppStore.getState().fileBuffers[
      fileBufferKey(WS, AGENT_FILE)
    ];
    expect(buffer?.loaded).toBe(true);
    expect(buffer?.baseline).toBe("# Plan");
    expect(container.textContent).toContain("agent_file_badge_plan");
  });
});
