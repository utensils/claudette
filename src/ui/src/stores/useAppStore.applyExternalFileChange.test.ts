import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

const WS = "workspace-a";
const PATH = "src/main.ts";
const KEY = `${WS}:${PATH}`;

function reset() {
  useAppStore.setState({
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileBuffers: {},
    allFilesExpandedDirsByWorkspace: {},
    allFilesSelectedPathByWorkspace: {},
    tabOrderByWorkspace: {},
    filePathUndoStackByWorkspace: {},
  });
}

function openLoadedFile(content: string) {
  useAppStore.getState().openFileTab(WS, PATH);
  useAppStore.getState().setFileBufferLoaded(WS, PATH, {
    baseline: content,
    isBinary: false,
    isSymlink: false,
    sizeBytes: content.length,
    truncated: false,
    imageBytesB64: null,
  });
}

describe("applyExternalFileChange", () => {
  beforeEach(reset);

  it("no-ops when the buffer hasn't been opened", () => {
    useAppStore.getState().applyExternalFileChange(WS, PATH, "anything", 8, false);
    expect(useAppStore.getState().fileBuffers[KEY]).toBeUndefined();
  });

  it("no-ops when the buffer is still loading", () => {
    useAppStore.getState().openFileTab(WS, PATH);
    // Buffer slot exists but `loaded === false` — the initial-load
    // effect hasn't filled it yet. Applying an external change here
    // would race the load and could overwrite it; the action bails.
    useAppStore.getState().applyExternalFileChange(WS, PATH, "disk", 4, false);
    const buf = useAppStore.getState().fileBuffers[KEY];
    expect(buf?.loaded).toBe(false);
    expect(buf?.buffer).toBe("");
  });

  it("is idempotent against the buffer's own save (echo defense)", () => {
    openLoadedFile("v1");
    // Watcher fires after our own write — disk content matches the
    // baseline we just saved. Must NOT bump anything.
    useAppStore.getState().applyExternalFileChange(WS, PATH, "v1", 2, false);
    const buf = useAppStore.getState().fileBuffers[KEY];
    expect(buf.baseline).toBe("v1");
    expect(buf.externallyChanged).toBe(false);
  });

  it("auto-updates baseline + buffer when the buffer is clean", () => {
    openLoadedFile("v1");
    useAppStore.getState().applyExternalFileChange(WS, PATH, "v2", 2, false);
    const buf = useAppStore.getState().fileBuffers[KEY];
    // Both baseline and buffer follow disk; Monaco picks up the
    // change via the controlled-`value` prop and applies via
    // `executeEdits`.
    expect(buf.baseline).toBe("v2");
    expect(buf.buffer).toBe("v2");
    expect(buf.sizeBytes).toBe(2);
    expect(buf.externallyChanged).toBe(false);
  });

  it("never clobbers a dirty buffer; raises the externally-changed flag", () => {
    openLoadedFile("v1");
    useAppStore.getState().setFileBufferContent(WS, PATH, "user edit");

    useAppStore
      .getState()
      .applyExternalFileChange(WS, PATH, "agent edit", 10, false);

    const buf = useAppStore.getState().fileBuffers[KEY];
    // Buffer untouched: user keeps their unsaved edits.
    expect(buf.buffer).toBe("user edit");
    // Baseline anchored at the version they started editing from.
    // Bumping it would change the dirty diff under their feet.
    expect(buf.baseline).toBe("v1");
    expect(buf.externallyChanged).toBe(true);
  });

  it("setFileBufferSaved clears the externally-changed flag", () => {
    openLoadedFile("v1");
    useAppStore.getState().setFileBufferContent(WS, PATH, "user edit");
    useAppStore
      .getState()
      .applyExternalFileChange(WS, PATH, "agent edit", 10, false);

    expect(useAppStore.getState().fileBuffers[KEY].externallyChanged).toBe(true);

    // User saves their version (last-write-wins by design).
    useAppStore.getState().setFileBufferSaved(WS, PATH, "user edit");

    const buf = useAppStore.getState().fileBuffers[KEY];
    expect(buf.baseline).toBe("user edit");
    expect(buf.externallyChanged).toBe(false);
  });

  it("reloadFileBufferFromDisk drops the dirty buffer and clears the flag", () => {
    openLoadedFile("v1");
    useAppStore.getState().setFileBufferContent(WS, PATH, "user edit");
    useAppStore
      .getState()
      .applyExternalFileChange(WS, PATH, "agent edit", 10, false);

    useAppStore
      .getState()
      .reloadFileBufferFromDisk(WS, PATH, "agent edit", 10, false);

    const buf = useAppStore.getState().fileBuffers[KEY];
    expect(buf.baseline).toBe("agent edit");
    expect(buf.buffer).toBe("agent edit");
    expect(buf.externallyChanged).toBe(false);
  });
});
