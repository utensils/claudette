import { describe, expect, it } from "vitest";
import {
  getReasoningLevels,
  normalizeReasoningLevel,
  reasoningLevelLabel,
  reasoningVariantForModel,
} from "./reasoningControls";

describe("reasoningControls", () => {
  it("uses Codex reasoning terminology and levels for native Codex models", () => {
    const variant = reasoningVariantForModel({
      providerId: "experimental-codex",
      providerKind: "codex_native",
    });

    expect(variant).toBe("codex");
    expect(getReasoningLevels("gpt-5.4", variant).map((level) => level.id)).toEqual([
      "auto",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(reasoningLevelLabel("auto", "gpt-5.4", variant)).toBe("Default");
  });

  it("normalizes stale Claude max effort to Codex high", () => {
    expect(normalizeReasoningLevel("max", "gpt-5.4", "codex")).toBe("high");
    expect(normalizeReasoningLevel("minimal", "sonnet", "claude")).toBe("auto");
  });
});
