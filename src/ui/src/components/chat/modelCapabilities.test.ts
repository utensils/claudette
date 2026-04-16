import { describe, it, expect } from "vitest";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "./modelCapabilities";

describe("isFastSupported", () => {
  it("returns true for claude-opus-4-6", () => {
    expect(isFastSupported("claude-opus-4-6")).toBe(true);
  });

  it("returns false for opus alias", () => {
    expect(isFastSupported("opus")).toBe(false);
  });

  it("returns false for claude-opus-4-7", () => {
    expect(isFastSupported("claude-opus-4-7")).toBe(false);
  });

  it("returns false for sonnet", () => {
    expect(isFastSupported("sonnet")).toBe(false);
  });

  it("returns false for haiku", () => {
    expect(isFastSupported("haiku")).toBe(false);
  });
});

describe("isEffortSupported", () => {
  it("returns true for opus", () => {
    expect(isEffortSupported("opus")).toBe(true);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isEffortSupported("claude-opus-4-7")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isEffortSupported("claude-opus-4-6")).toBe(true);
  });

  it("returns true for sonnet", () => {
    expect(isEffortSupported("sonnet")).toBe(true);
  });

  it("returns false for haiku", () => {
    expect(isEffortSupported("haiku")).toBe(false);
  });

  it("returns false for unknown models", () => {
    expect(isEffortSupported("unknown-model")).toBe(false);
  });
});

describe("isXhighEffortAllowed", () => {
  it("returns true for opus", () => {
    expect(isXhighEffortAllowed("opus")).toBe(true);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isXhighEffortAllowed("claude-opus-4-7")).toBe(true);
  });

  it("returns false for claude-opus-4-6", () => {
    expect(isXhighEffortAllowed("claude-opus-4-6")).toBe(false);
  });

  it("returns false for sonnet", () => {
    expect(isXhighEffortAllowed("sonnet")).toBe(false);
  });

  it("returns false for haiku", () => {
    expect(isXhighEffortAllowed("haiku")).toBe(false);
  });
});

describe("isMaxEffortAllowed", () => {
  it("returns true for opus", () => {
    expect(isMaxEffortAllowed("opus")).toBe(true);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isMaxEffortAllowed("claude-opus-4-7")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortAllowed("claude-opus-4-6")).toBe(true);
  });

  it("returns false for sonnet", () => {
    expect(isMaxEffortAllowed("sonnet")).toBe(false);
  });

  it("returns false for haiku", () => {
    expect(isMaxEffortAllowed("haiku")).toBe(false);
  });
});
