import { describe, it, expect } from "vitest";
import type { AgentStatus } from "../types/workspace";
import { isAgentBusy } from "./agentStatus";

describe("isAgentBusy", () => {
  it("returns true for Running", () => {
    expect(isAgentBusy("Running")).toBe(true);
  });
  it("returns true for Compacting", () => {
    expect(isAgentBusy("Compacting")).toBe(true);
  });
  it("returns false for Idle", () => {
    expect(isAgentBusy("Idle")).toBe(false);
  });
  it("returns false for Stopped", () => {
    expect(isAgentBusy("Stopped")).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(isAgentBusy(undefined)).toBe(false);
  });
  it("returns false for null", () => {
    expect(isAgentBusy(null)).toBe(false);
  });
  it("returns false for Error variant object", () => {
    // AgentStatus can be { Error: string } — should NOT count as busy
    expect(isAgentBusy({ Error: "boom" } as unknown as AgentStatus)).toBe(false);
  });
});
