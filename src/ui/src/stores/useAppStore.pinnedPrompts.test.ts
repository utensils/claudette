import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import { selectMergedPinnedPrompts } from "./slices/pinnedPromptsSlice";
import type { PinnedPrompt } from "../services/tauri";

function makePrompt(
  id: number,
  display_name: string,
  prompt: string,
  repo_id: string | null,
  auto_send = false,
): PinnedPrompt {
  return {
    id,
    repo_id,
    display_name,
    prompt,
    auto_send,
    sort_order: id,
    created_at: "",
  };
}

describe("pinnedPromptsSlice merge selector", () => {
  beforeEach(() => {
    useAppStore.setState({
      globalPinnedPrompts: [],
      repoPinnedPrompts: {},
    });
  });

  it("returns globals when no repo is active", () => {
    useAppStore.setState({
      globalPinnedPrompts: [makePrompt(1, "Standup", "Standup", null, true)],
    });
    const merged = selectMergedPinnedPrompts(useAppStore.getState(), null);
    expect(merged.map((p) => p.display_name)).toEqual(["Standup"]);
  });

  it("merges repo entries first then non-shadowed globals", () => {
    useAppStore.setState({
      globalPinnedPrompts: [
        makePrompt(1, "Review", "/review --global", null),
        makePrompt(2, "Deploy", "/deploy", null),
      ],
      repoPinnedPrompts: {
        r1: [
          makePrompt(10, "Review", "/review --repo", "r1"),
          makePrompt(11, "Test", "/test", "r1", true),
        ],
      },
    });
    const merged = selectMergedPinnedPrompts(useAppStore.getState(), "r1");
    expect(merged.map((p) => p.display_name)).toEqual([
      "Review",
      "Test",
      "Deploy",
    ]);
    // The repo's "Review" wins; the global is shadowed.
    expect(merged[0].prompt).toBe("/review --repo");
  });

  it("shows only globals when the repo has no prompts", () => {
    useAppStore.setState({
      globalPinnedPrompts: [makePrompt(1, "Standup", "Standup", null, true)],
      repoPinnedPrompts: { r1: [] },
    });
    const merged = selectMergedPinnedPrompts(useAppStore.getState(), "r1");
    expect(merged.map((p) => p.display_name)).toEqual(["Standup"]);
  });
});

describe("pinnedPromptsSlice mutators", () => {
  beforeEach(() => {
    useAppStore.setState({
      globalPinnedPrompts: [],
      repoPinnedPrompts: {},
    });
  });

  it("upsertPinnedPrompt inserts globals when repo_id is null", () => {
    useAppStore
      .getState()
      .upsertPinnedPrompt(makePrompt(1, "Standup", "Standup", null, true));
    expect(useAppStore.getState().globalPinnedPrompts).toHaveLength(1);
    expect(useAppStore.getState().globalPinnedPrompts[0].display_name).toBe(
      "Standup",
    );
  });

  it("upsertPinnedPrompt replaces an existing entry by id", () => {
    useAppStore.setState({
      globalPinnedPrompts: [makePrompt(1, "Standup", "old", null, false)],
    });
    useAppStore
      .getState()
      .upsertPinnedPrompt(makePrompt(1, "Standup", "new", null, true));
    expect(useAppStore.getState().globalPinnedPrompts).toHaveLength(1);
    expect(useAppStore.getState().globalPinnedPrompts[0].prompt).toBe("new");
    expect(useAppStore.getState().globalPinnedPrompts[0].auto_send).toBe(true);
  });

  it("upsertPinnedPrompt routes repo prompts under their repo_id key", () => {
    useAppStore
      .getState()
      .upsertPinnedPrompt(makePrompt(5, "Test", "/test", "r1", true));
    expect(useAppStore.getState().repoPinnedPrompts.r1).toHaveLength(1);
    expect(useAppStore.getState().globalPinnedPrompts).toHaveLength(0);
  });

  it("removePinnedPromptById drops the entry from whichever scope it lives in", () => {
    useAppStore.setState({
      globalPinnedPrompts: [makePrompt(1, "Global", "g", null)],
      repoPinnedPrompts: { r1: [makePrompt(2, "Repo", "r", "r1")] },
    });
    useAppStore.getState().removePinnedPromptById(2);
    expect(useAppStore.getState().repoPinnedPrompts.r1).toHaveLength(0);
    expect(useAppStore.getState().globalPinnedPrompts).toHaveLength(1);
  });

  it("removePinnedPromptById is a no-op when the id isn't anywhere", () => {
    const initialGlobals = [makePrompt(1, "Global", "g", null)];
    const initialRepos = { r1: [makePrompt(2, "Repo", "r", "r1")] };
    useAppStore.setState({
      globalPinnedPrompts: initialGlobals,
      repoPinnedPrompts: initialRepos,
    });
    useAppStore.getState().removePinnedPromptById(999);
    // Same references — no spurious set() that would notify subscribers.
    expect(useAppStore.getState().globalPinnedPrompts).toBe(initialGlobals);
    expect(useAppStore.getState().repoPinnedPrompts).toBe(initialRepos);
  });
});
