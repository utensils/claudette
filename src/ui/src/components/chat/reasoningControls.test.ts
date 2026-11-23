import { describe, expect, it } from "vitest";
import {
  getReasoningLevels,
  normalizeReasoningLevel,
  reasoningLevelLabel,
  reasoningVariantForModel,
} from "./reasoningControls";

describe("reasoningControls", () => {
  it("uses Codex intelligence terminology and levels for native Codex models", () => {
    const variant = reasoningVariantForModel({
      providerId: "codex",
      providerKind: "codex_native",
    });

    expect(variant).toBe("codex");
    expect(getReasoningLevels("gpt-5.4", variant).map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(reasoningLevelLabel("xhigh", "gpt-5.4", variant)).toBe("Extra High");
  });

  it("normalizes stale and empty Codex effort values to high intelligence", () => {
    expect(normalizeReasoningLevel("max", "gpt-5.4", "codex")).toBe("high");
    expect(normalizeReasoningLevel("auto", "gpt-5.4", "codex")).toBe("high");
    expect(normalizeReasoningLevel("minimal", "gpt-5.4", "codex")).toBe("high");
    expect(normalizeReasoningLevel(undefined, "gpt-5.4", "codex")).toBe("high");
    expect(normalizeReasoningLevel("minimal", "sonnet", "claude")).toBe("auto");
  });

  it("uses Antigravity reasoning levels and normalizes max to xhigh", () => {
    const variant = reasoningVariantForModel({
      providerId: "antigravity",
      providerKind: "antigravity",
    });

    expect(variant).toBe("antigravity");
    expect(getReasoningLevels("gemini-4-neon", variant).map((level) => level.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(normalizeReasoningLevel("auto", "gemini-4-neon", "antigravity")).toBe("high");
    expect(normalizeReasoningLevel("max", "gemini-4-neon", "antigravity")).toBe("xhigh");
    expect(normalizeReasoningLevel(undefined, "gemini-4-neon", "antigravity")).toBe("high");
  });
});
