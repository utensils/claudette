import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_BACKEND,
  DEFAULT_CLAUDE_MODEL,
  isAlternativeBackendSelection,
  planAlternativeBackendDisableCleanup,
} from "./alternativeBackendCleanup";

describe("planAlternativeBackendDisableCleanup", () => {
  it("resets experimental defaults and sessions to the built-in Claude default", () => {
    const plan = planAlternativeBackendDisableCleanup({
      defaultModel: "gpt-5.5",
      defaultBackend: "codex-subscription",
      sessionModels: [["model:sess-1", "gpt-5.5"]],
      sessionProviders: [["model_provider:sess-1", "codex-subscription"]],
      selectedModels: {},
      selectedProviders: {},
    });

    expect(plan).toEqual({
      defaultModel: DEFAULT_CLAUDE_MODEL,
      defaultBackend: DEFAULT_CLAUDE_BACKEND,
      resetDefault: true,
      sessionIds: ["sess-1"],
    });
  });

  it("keeps an Anthropic default and resets experimental sessions to that default", () => {
    const plan = planAlternativeBackendDisableCleanup({
      defaultModel: "sonnet",
      defaultBackend: "anthropic",
      sessionModels: [["model:sess-1", "qwen3-coder"]],
      sessionProviders: [["model_provider:sess-1", "ollama"]],
      selectedModels: { "sess-2": "gpt-5.5" },
      selectedProviders: { "sess-2": "codex-subscription" },
    });

    expect(plan.defaultModel).toBe("sonnet");
    expect(plan.resetDefault).toBe(false);
    expect(plan.sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  it("leaves built-in Claude sessions alone", () => {
    const plan = planAlternativeBackendDisableCleanup({
      defaultModel: "haiku",
      defaultBackend: "anthropic",
      sessionModels: [["model:sess-1", "sonnet"]],
      sessionProviders: [["model_provider:sess-1", "anthropic"]],
      selectedModels: { "sess-2": "opus" },
      selectedProviders: { "sess-2": "anthropic" },
    });

    expect(plan.resetDefault).toBe(false);
    expect(plan.sessionIds).toEqual([]);
  });
});

describe("isAlternativeBackendSelection", () => {
  it("treats unknown Anthropic-provider models as unsafe when the feature is off", () => {
    expect(isAlternativeBackendSelection("future-gpt", "anthropic")).toBe(true);
  });

  it("treats lm-studio sessions as alternative so the cleanup walker resets them", () => {
    expect(isAlternativeBackendSelection("qwen2.5-coder-7b-instruct", "lm-studio")).toBe(true);

    // And the planner picks them up alongside ollama / codex sessions.
    const plan = planAlternativeBackendDisableCleanup({
      defaultModel: "opus",
      defaultBackend: "anthropic",
      sessionModels: [["model:sess-1", "qwen2.5-coder-7b-instruct"]],
      sessionProviders: [["model_provider:sess-1", "lm-studio"]],
      selectedModels: {},
      selectedProviders: {},
    });
    expect(plan.sessionIds).toContain("sess-1");
  });
});
