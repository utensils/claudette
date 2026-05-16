import { describe, it, expect } from "vitest";

import { isContextWindowError } from "./contextOverflowDetection";

describe("isContextWindowError", () => {
  it("matches Anthropic's 'Input is too long' message", () => {
    expect(
      isContextWindowError("Input is too long for requested model"),
    ).toBe(true);
  });

  it("matches OpenAI-style 'maximum context length' messages", () => {
    expect(
      isContextWindowError(
        "This model's maximum context length is 8192 tokens, however you requested 12000 tokens",
      ),
    ).toBe(true);
  });

  it("matches 'exceeds the maximum' phrasing", () => {
    expect(
      isContextWindowError("Your prompt is 30000 tokens, exceeds the maximum allowed."),
    ).toBe(true);
  });

  it("matches LM Studio's 'tokens to keep' phrasing", () => {
    expect(
      isContextWindowError(
        "Trying to keep 8000 tokens to keep, but the context window is only 4096",
      ),
    ).toBe(true);
  });

  it("matches Codex's 'context window exceeded' phrasing", () => {
    expect(isContextWindowError("Error: context window exceeded")).toBe(true);
  });

  it("matches Pi-sidecar passthrough variants", () => {
    expect(isContextWindowError("prompt is too long")).toBe(true);
    expect(isContextWindowError("context length is too small for this conversation")).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(isContextWindowError("CONTEXT WINDOW IS TOO SMALL")).toBe(true);
    expect(isContextWindowError("Input Is Too Long For This Model")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isContextWindowError("Not logged in · Please run /login")).toBe(false);
    expect(isContextWindowError("Failed to authenticate")).toBe(false);
    expect(isContextWindowError("Workspace directory is missing: /tmp/foo")).toBe(
      false,
    );
    expect(isContextWindowError("claude is not installed.")).toBe(false);
  });

  it("does not match model-not-loaded errors (different recovery)", () => {
    // These are still permanent failures, but the right recovery is
    // "load the model" or "pick another model", not "pick a model
    // with a larger window". Keep the detection narrow.
    expect(isContextWindowError("model is not loaded")).toBe(false);
    expect(isContextWindowError("model not found")).toBe(false);
  });

  it("handles empty / whitespace", () => {
    expect(isContextWindowError("")).toBe(false);
    expect(isContextWindowError("   ")).toBe(false);
  });
});
