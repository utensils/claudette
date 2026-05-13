import { describe, it, expect, vi } from "vitest";
import {
  buildSetupScriptContent,
  buildSetupScriptErrorContent,
  parseSetupScriptMessage,
  recordSetupScriptResult,
  recordSetupScriptError,
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

describe("buildSetupScriptContent / parseSetupScriptMessage", () => {
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
    expect(parseSetupScriptMessage("Setup script (settings) is running")).toBeNull();
  });
});

describe("recordSetupScriptResult / recordSetupScriptError", () => {
  it("appends a System message and no toast on success", () => {
    const addChatMessage = vi.fn();
    const addToast = vi.fn();
    recordSetupScriptResult("sess", "ws", result({ output: "ok" }), { addChatMessage, addToast });
    expect(addChatMessage).toHaveBeenCalledTimes(1);
    const [sessionId, msg] = addChatMessage.mock.calls[0];
    expect(sessionId).toBe("sess");
    expect(msg).toMatchObject({
      role: "System",
      workspace_id: "ws",
      chat_session_id: "sess",
      content: "Setup script (settings) completed:\nok",
    });
    expect(addToast).not.toHaveBeenCalled();
  });

  it("raises a failure toast when the run did not succeed", () => {
    const addChatMessage = vi.fn();
    const addToast = vi.fn();
    recordSetupScriptResult("sess", "ws", result({ success: false, exit_code: 1, output: "boom" }), {
      addChatMessage,
      addToast,
      workspaceName: "twisted-tarragon",
    });
    expect(addChatMessage).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toContain("twisted-tarragon");
  });

  it("records the catch-path message and a toast", () => {
    const addChatMessage = vi.fn();
    const addToast = vi.fn();
    recordSetupScriptError("sess", "ws", new Error("nope"), { addChatMessage, addToast });
    expect(addChatMessage).toHaveBeenCalledTimes(1);
    expect(addChatMessage.mock.calls[0][1].content).toBe("Setup script failed: Error: nope");
    expect(addToast).toHaveBeenCalledTimes(1);
  });
});
