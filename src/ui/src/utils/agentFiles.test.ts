import { describe, expect, it, vi } from "vitest";

import {
  agentFileKindI18nKey,
  classifyAgentFile,
  tryOpenAgentFileTab,
} from "./agentFiles";

describe("classifyAgentFile", () => {
  it("classifies a Claude plan file", () => {
    const result = classifyAgentFile(
      "/Users/me/.claude/plans/sunny-otter.md",
    );
    expect(result).toEqual({
      kind: "plan",
      path: "/Users/me/.claude/plans/sunny-otter.md",
    });
  });

  it("classifies a project memory note", () => {
    expect(
      classifyAgentFile(
        "/Users/me/.claude/projects/-Users-me-proj/memory/feedback_testing.md",
      )?.kind,
    ).toBe("memory");
  });

  it("classifies the MEMORY.md index distinctly", () => {
    expect(
      classifyAgentFile(
        "/Users/me/.claude/projects/-Users-me-proj/memory/MEMORY.md",
      )?.kind,
    ).toBe("memory-index");
  });

  it("classifies other project markdown as a project file", () => {
    expect(
      classifyAgentFile(
        "/Users/me/.claude/projects/-Users-me-proj/scratch-notes.md",
      )?.kind,
    ).toBe("project-file");
  });

  it("classifies Codex memory files", () => {
    expect(
      classifyAgentFile("/Users/me/.codex/memories/raw_memories.md")?.kind,
    ).toBe("memory");
    expect(
      classifyAgentFile("/Users/me/.codex/memories/MEMORY.md")?.kind,
    ).toBe("memory-index");
    expect(
      classifyAgentFile(
        "/Users/me/.codex/memories/rollout_summaries/2026-05-12-foo.md",
      )?.kind,
    ).toBe("memory");
  });

  it("strips a trailing :line suffix from the tab key", () => {
    expect(
      classifyAgentFile("/Users/me/.claude/plans/x.md:42"),
    ).toEqual({ kind: "plan", path: "/Users/me/.claude/plans/x.md" });
  });

  it("recognizes Windows-drive absolute paths", () => {
    expect(
      classifyAgentFile("C:/Users/me/.claude/plans/x.md")?.kind,
    ).toBe("plan");
  });

  it("normalizes backslashes in the tab key", () => {
    expect(
      classifyAgentFile("C:\\Users\\me\\.claude\\plans\\x.md")?.path,
    ).toBe("C:/Users/me/.claude/plans/x.md");
  });

  it("rejects non-markdown files under an allow-listed root", () => {
    expect(classifyAgentFile("/Users/me/.claude/plans/notes.txt")).toBeNull();
  });

  it("rejects workspace-relative paths", () => {
    expect(classifyAgentFile("src/main.rs")).toBeNull();
    expect(classifyAgentFile("plans/foo.md")).toBeNull();
    expect(classifyAgentFile(".claude/plans/foo.md")).toBeNull();
  });

  it("rejects arbitrary absolute paths", () => {
    expect(classifyAgentFile("/Users/me/Documents/notes.md")).toBeNull();
    expect(classifyAgentFile("/etc/passwd")).toBeNull();
  });

  it("rejects an empty or anchorless path", () => {
    expect(classifyAgentFile("")).toBeNull();
    expect(classifyAgentFile("/")).toBeNull();
  });
});

describe("tryOpenAgentFileTab", () => {
  it("opens an agent file tab and reports success", () => {
    const openFileTab = vi.fn();
    const opened = tryOpenAgentFileTab(
      "ws-1",
      "/Users/me/.claude/plans/x.md",
      openFileTab,
    );
    expect(opened).toBe(true);
    expect(openFileTab).toHaveBeenCalledWith(
      "ws-1",
      "/Users/me/.claude/plans/x.md",
    );
  });

  it("does nothing for a non-agent path", () => {
    const openFileTab = vi.fn();
    expect(tryOpenAgentFileTab("ws-1", "src/main.rs", openFileTab)).toBe(false);
    expect(openFileTab).not.toHaveBeenCalled();
  });

  it("does nothing without a workspace", () => {
    const openFileTab = vi.fn();
    expect(
      tryOpenAgentFileTab(null, "/Users/me/.claude/plans/x.md", openFileTab),
    ).toBe(false);
    expect(openFileTab).not.toHaveBeenCalled();
  });
});

describe("agentFileKindI18nKey", () => {
  it("maps every kind to a chat-namespace key", () => {
    expect(agentFileKindI18nKey("plan")).toBe("agent_file_badge_plan");
    expect(agentFileKindI18nKey("memory")).toBe("agent_file_badge_memory");
    expect(agentFileKindI18nKey("memory-index")).toBe(
      "agent_file_badge_memory_index",
    );
    expect(agentFileKindI18nKey("project-file")).toBe(
      "agent_file_badge_project",
    );
  });
});
