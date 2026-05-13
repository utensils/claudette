import { describe, it, expect, vi } from "vitest";
import {
  buildSetupScriptContent,
  buildSetupScriptErrorContent,
  parseSetupScriptMessage,
  runAndRecordSetupScript,
  type SetupScriptRecorderDeps,
} from "./setupScriptMessage";
import type { SetupResult } from "../types/repository";

function result(over: Partial<SetupResult> = {}): SetupResult {
  return {
    source: "settings",
    script: "bun install",
    output: "",
    exit_code: 0,
    success: true,
    timed_out: false,
    ...over,
  };
}

function makeDeps(over: Partial<SetupScriptRecorderDeps> = {}): SetupScriptRecorderDeps {
  return {
    addChatMessage: vi.fn(),
    setRunningSetupScript: vi.fn(),
    addToast: vi.fn(),
    ...over,
  };
}

describe("build / parse setup-script content", () => {
  it("round-trips a completed run with output", () => {
    const sr = result({ output: "Resolved 1657 packages\ndone" });
    const content = buildSetupScriptContent(sr);
    expect(content).toBe("Setup script (settings) completed:\nResolved 1657 packages\ndone");
    expect(parseSetupScriptMessage(content)).toEqual({
      source: "settings",
      status: "completed",
      output: "Resolved 1657 packages\ndone",
    });
  });

  it("round-trips a completed run with no output", () => {
    const content = buildSetupScriptContent(result({ output: "" }));
    expect(content).toBe("Setup script (settings) completed");
    expect(parseSetupScriptMessage(content)).toEqual({
      source: "settings",
      status: "completed",
      output: "",
    });
  });

  it("uses the .claudette.json label for repo-config scripts", () => {
    const content = buildSetupScriptContent(result({ source: "repo", output: "ok" }));
    expect(content).toBe("Setup script (.claudette.json) completed:\nok");
    expect(parseSetupScriptMessage(content)?.source).toBe(".claudette.json");
  });

  it("maps an unsuccessful run to failed", () => {
    const content = buildSetupScriptContent(result({ success: false, exit_code: 1, output: "boom" }));
    expect(content).toBe("Setup script (settings) failed:\nboom");
    expect(parseSetupScriptMessage(content)).toEqual({
      source: "settings",
      status: "failed",
      output: "boom",
    });
  });

  it("maps a timed-out run to timed-out", () => {
    const content = buildSetupScriptContent(
      result({ success: false, exit_code: null, timed_out: true, output: "slow…" }),
    );
    expect(content).toBe("Setup script (settings) timed out:\nslow…");
    expect(parseSetupScriptMessage(content)).toEqual({
      source: "settings",
      status: "timed-out",
      output: "slow…",
    });
  });

  it("parses the catch-path error message", () => {
    const content = buildSetupScriptErrorContent(new Error("spawn failed"));
    expect(content).toBe("Setup script failed: Error: spawn failed");
    expect(parseSetupScriptMessage(content)).toEqual({
      source: null,
      status: "failed",
      output: "Error: spawn failed",
    });
  });

  it("returns null for unrelated content", () => {
    expect(parseSetupScriptMessage("")).toBeNull();
    expect(parseSetupScriptMessage("Just a regular system note")).toBeNull();
    expect(parseSetupScriptMessage("COMPACTION:manual:1:2:3")).toBeNull();
    // "running" is never a message — it lives in the store, not the transcript.
    expect(parseSetupScriptMessage("Setup script (settings) running")).toBeNull();
  });
});

describe("runAndRecordSetupScript", () => {
  it("flags the session running, then clears it and appends the result", async () => {
    const deps = makeDeps();
    let resolveRun!: (v: SetupResult | null) => void;
    runAndRecordSetupScript({
      sessionId: "sess",
      workspaceId: "ws",
      source: "settings",
      run: () => new Promise<SetupResult | null>((res) => { resolveRun = res; }),
      deps,
    });

    expect(deps.setRunningSetupScript).toHaveBeenCalledWith("sess", "settings");
    expect(deps.addChatMessage).not.toHaveBeenCalled();

    resolveRun(result({ output: "ok" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.setRunningSetupScript).toHaveBeenLastCalledWith("sess", null);
    expect(deps.addChatMessage).toHaveBeenCalledTimes(1);
    const [, msg, options] = (deps.addChatMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toMatchObject({ role: "System", content: "Setup script (settings) completed:\nok" });
    expect(options).toEqual({ persisted: false });
    expect(deps.addToast).not.toHaveBeenCalled();
  });

  it("stores the user-facing label for a repo-config script so the running banner matches the result", async () => {
    const deps = makeDeps();
    runAndRecordSetupScript({
      sessionId: "sess",
      workspaceId: "ws",
      source: "repo",
      run: async () => result({ source: "repo", output: "ok" }),
      deps,
    });
    // Running banner label: ".claudette.json" — not the raw "repo" — matching
    // what `buildSetupScriptContent` writes for the completed entry.
    expect(deps.setRunningSetupScript).toHaveBeenNthCalledWith(1, "sess", ".claudette.json");
    await Promise.resolve();
    await Promise.resolve();
    const [, msg] = (deps.addChatMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.content).toBe("Setup script (.claudette.json) completed:\nok");
  });

  it("raises a failure toast and appends the failed content", async () => {
    const deps = makeDeps({ workspaceName: "twisted-tarragon" });
    runAndRecordSetupScript({
      sessionId: "sess",
      workspaceId: "ws",
      source: "settings",
      run: async () => result({ success: false, exit_code: 1, output: "boom" }),
      deps,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setRunningSetupScript).toHaveBeenLastCalledWith("sess", null);
    const [, msg] = (deps.addChatMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.content).toBe("Setup script (settings) failed:\nboom");
    expect(deps.addToast).toHaveBeenCalledTimes(1);
    expect((deps.addToast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("twisted-tarragon");
  });

  it("appends the catch-path content and toasts when run() rejects", async () => {
    const deps = makeDeps();
    runAndRecordSetupScript({
      sessionId: "sess",
      workspaceId: "ws",
      source: "repo",
      run: async () => { throw new Error("nope"); },
      deps,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setRunningSetupScript).toHaveBeenLastCalledWith("sess", null);
    const [, msg] = (deps.addChatMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.content).toBe("Setup script failed: Error: nope");
    expect(deps.addToast).toHaveBeenCalledTimes(1);
  });

  it("clears the running flag and appends nothing when no script actually ran", async () => {
    const deps = makeDeps();
    runAndRecordSetupScript({
      sessionId: "sess",
      workspaceId: "ws",
      source: "settings",
      run: async () => null,
      deps,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setRunningSetupScript).toHaveBeenLastCalledWith("sess", null);
    expect(deps.addChatMessage).not.toHaveBeenCalled();
    expect(deps.addToast).not.toHaveBeenCalled();
  });
});
