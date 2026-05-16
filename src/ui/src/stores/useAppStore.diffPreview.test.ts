import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { FileContent } from "../services/tauri";

const WS_A = "workspace-a";

const SAMPLE_PREVIEW: FileContent = {
  path: "README.md",
  content: "# Hello\n",
  is_binary: false,
  is_symlink: false,
  size_bytes: 7,
  truncated: false,
};

function reset() {
  useAppStore.setState({
    diffTabsByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    diffContent: null,
    diffError: null,
    diffPreviewMode: "diff",
    diffPreviewContent: null,
    diffPreviewLoading: false,
    diffPreviewError: null,
    sessionsByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
  });
}

describe("diff preview state", () => {
  beforeEach(reset);

  it("starts in diff mode with no preview content", () => {
    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("diff");
    expect(s.diffPreviewContent).toBeNull();
    expect(s.diffPreviewLoading).toBe(false);
    expect(s.diffPreviewError).toBeNull();
  });

  it("setDiffPreviewMode toggles between diff and rendered", () => {
    useAppStore.getState().setDiffPreviewMode("rendered");
    expect(useAppStore.getState().diffPreviewMode).toBe("rendered");
    useAppStore.getState().setDiffPreviewMode("diff");
    expect(useAppStore.getState().diffPreviewMode).toBe("diff");
  });

  it("selectDiffTab resets preview state when selection changes", () => {
    useAppStore.getState().openDiffTab(WS_A, "README.md", "unstaged");
    useAppStore.getState().setDiffPreviewMode("rendered");
    useAppStore.getState().setDiffPreviewContent(SAMPLE_PREVIEW);
    useAppStore.getState().setDiffPreviewError("stale");

    useAppStore.getState().openDiffTab(WS_A, "OTHER.md", "unstaged");
    useAppStore.getState().selectDiffTab("OTHER.md", "unstaged");

    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("diff");
    expect(s.diffPreviewContent).toBeNull();
    expect(s.diffPreviewError).toBeNull();
    expect(s.diffPreviewLoading).toBe(false);
  });

  it("selectDiffTab is a no-op when selection is unchanged", () => {
    useAppStore.getState().openDiffTab(WS_A, "README.md", "unstaged");
    useAppStore.getState().setDiffPreviewMode("rendered");
    useAppStore.getState().setDiffPreviewContent(SAMPLE_PREVIEW);

    useAppStore.getState().selectDiffTab("README.md", "unstaged");

    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("rendered");
    expect(s.diffPreviewContent).toEqual(SAMPLE_PREVIEW);
  });

  it("openDiffTab resets preview state when selection changes", () => {
    useAppStore.getState().openDiffTab(WS_A, "README.md", "unstaged");
    useAppStore.getState().setDiffPreviewMode("rendered");
    useAppStore.getState().setDiffPreviewContent(SAMPLE_PREVIEW);

    useAppStore.getState().openDiffTab(WS_A, "CHANGES.md", "unstaged");

    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("diff");
    expect(s.diffPreviewContent).toBeNull();
  });

  it("closeDiffTab clears preview when closing the active tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "README.md", "unstaged");
    useAppStore.getState().setDiffPreviewMode("rendered");
    useAppStore.getState().setDiffPreviewContent(SAMPLE_PREVIEW);

    useAppStore.getState().closeDiffTab(WS_A, "README.md", "unstaged");

    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("diff");
    expect(s.diffPreviewContent).toBeNull();
  });

  it("clearDiff resets preview state along with diff state", () => {
    useAppStore.getState().setDiffPreviewMode("rendered");
    useAppStore.getState().setDiffPreviewContent(SAMPLE_PREVIEW);
    useAppStore.getState().setDiffPreviewLoading(true);
    useAppStore.getState().setDiffPreviewError("oops");

    useAppStore.getState().clearDiff();

    const s = useAppStore.getState();
    expect(s.diffPreviewMode).toBe("diff");
    expect(s.diffPreviewContent).toBeNull();
    expect(s.diffPreviewLoading).toBe(false);
    expect(s.diffPreviewError).toBeNull();
  });
});
