import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";

describe("toolbarSlice.applyChatTurnSettings", () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedModel: {},
      selectedModelProvider: {},
      fastMode: {},
      thinkingEnabled: {},
      planMode: {},
      effortLevel: {},
      chromeEnabled: {},
    });
  });

  it("writes every field for the keyed chat session", () => {
    useAppStore.getState().applyChatTurnSettings({
      chatSessionId: "sess-1",
      model: "sonnet",
      backendId: "anthropic",
      fastMode: false,
      thinkingEnabled: true,
      planMode: true,
      effort: "high",
      chromeEnabled: true,
    });
    const s = useAppStore.getState();
    expect(s.selectedModel["sess-1"]).toBe("sonnet");
    expect(s.selectedModelProvider["sess-1"]).toBe("anthropic");
    expect(s.thinkingEnabled["sess-1"]).toBe(true);
    expect(s.planMode["sess-1"]).toBe(true);
    expect(s.effortLevel["sess-1"]).toBe("high");
    expect(s.chromeEnabled["sess-1"]).toBe(true);
    expect(s.fastMode["sess-1"]).toBe(false);
  });

  // Booleans always reflect the resolved AgentSettings — `false` is a real
  // value, not "unset". A turn that ran with plan_mode=false must clear a
  // previously-true toolbar flag, otherwise the input bar lies.
  it("overwrites booleans even when transitioning from true to false", () => {
    useAppStore.setState({
      planMode: { "sess-1": true },
      thinkingEnabled: { "sess-1": true },
      fastMode: { "sess-1": true },
      chromeEnabled: { "sess-1": true },
    });
    useAppStore.getState().applyChatTurnSettings({
      chatSessionId: "sess-1",
      model: null,
      backendId: null,
      fastMode: false,
      thinkingEnabled: false,
      planMode: false,
      effort: null,
      chromeEnabled: false,
    });
    const s = useAppStore.getState();
    expect(s.planMode["sess-1"]).toBe(false);
    expect(s.thinkingEnabled["sess-1"]).toBe(false);
    expect(s.fastMode["sess-1"]).toBe(false);
    expect(s.chromeEnabled["sess-1"]).toBe(false);
  });

  // model=null means the agent fell back to a workspace/global default we
  // can't observe from the event payload. Leaving the existing toolbar
  // selection alone is the only honest behavior — clearing it would hide
  // the user's prior choice with no way to recover it.
  it("leaves model + effort untouched when payload omits them (null)", () => {
    useAppStore.setState({
      selectedModel: { "sess-1": "opus" },
      selectedModelProvider: { "sess-1": "codex-subscription" },
      effortLevel: { "sess-1": "medium" },
    });
    useAppStore.getState().applyChatTurnSettings({
      chatSessionId: "sess-1",
      model: null,
      backendId: null,
      fastMode: false,
      thinkingEnabled: false,
      planMode: false,
      effort: null,
      chromeEnabled: false,
    });
    const s = useAppStore.getState();
    expect(s.selectedModel["sess-1"]).toBe("opus");
    expect(s.selectedModelProvider["sess-1"]).toBe("codex-subscription");
    expect(s.effortLevel["sess-1"]).toBe("medium");
  });

  it("scopes updates to the keyed session and leaves siblings alone", () => {
    useAppStore.setState({
      selectedModel: { "sess-1": "opus", "sess-2": "haiku" },
      selectedModelProvider: { "sess-1": "anthropic", "sess-2": "anthropic" },
      planMode: { "sess-2": true },
    });
    useAppStore.getState().applyChatTurnSettings({
      chatSessionId: "sess-1",
      model: "sonnet",
      backendId: "codex-subscription",
      fastMode: true,
      thinkingEnabled: false,
      planMode: false,
      effort: null,
      chromeEnabled: false,
    });
    const s = useAppStore.getState();
    expect(s.selectedModel["sess-1"]).toBe("sonnet");
    expect(s.selectedModel["sess-2"]).toBe("haiku");
    expect(s.selectedModelProvider["sess-1"]).toBe("codex-subscription");
    expect(s.selectedModelProvider["sess-2"]).toBe("anthropic");
    expect(s.planMode["sess-2"]).toBe(true);
    expect(s.planMode["sess-1"]).toBe(false);
    expect(s.fastMode["sess-1"]).toBe(true);
  });
});
