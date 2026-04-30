import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { Workspace } from "../types/workspace";
import type { ChatSession } from "../types/chat";
import type { Repository } from "../types/repository";

function makeWorkspace(id: string, repoId: string = "r1"): Workspace {
  return {
    id,
    repository_id: repoId,
    name: `ws-${id}`,
    branch_name: `branch-${id}`,
    worktree_path: null,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    remote_connection_id: null,
  };
}

function makeSession(id: string, wsId: string): ChatSession {
  return {
    id,
    workspace_id: wsId,
    session_id: null,
    name: `session-${id}`,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

function makeRepository(id: string): Repository {
  return {
    id,
    path: `/repo-${id}`,
    name: `repo-${id}`,
    path_slug: `repo-${id}`,
    icon: null,
    created_at: "2026-01-01T00:00:00Z",
    setup_script: null,
    custom_instructions: null,
    sort_order: 0,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    remote_connection_id: null,
  };
}

function reset() {
  useAppStore.setState({
    workspaces: [makeWorkspace("ws-a"), makeWorkspace("ws-b")],
    selectedWorkspaceId: "ws-a",
    diffTabsByWorkspace: {},
    diffSelectionByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    diffContent: null,
    diffError: null,
    diffPreviewMode: "diff",
    diffPreviewContent: null,
    diffPreviewLoading: false,
    diffPreviewError: null,
    sessionsByWorkspace: {
      "ws-a": [makeSession("s-a1", "ws-a"), makeSession("s-a2", "ws-a")],
      "ws-b": [makeSession("s-b1", "ws-b")],
    },
    selectedSessionIdByWorkspaceId: { "ws-a": "s-a1", "ws-b": "s-b1" },
    chatDrafts: {},
    unreadCompletions: new Set(),
    terminalTabs: {},
    activeTerminalTabId: {},
    workspaceTerminalCommands: {},
    terminalPaneTrees: {},
    activeTerminalPaneId: {},
    repositories: [],
  });
}

// ---------- Diff selection persistence ----------

describe("selectWorkspace diff selection persistence", () => {
  beforeEach(reset);

  it("is a no-op when re-selecting the current workspace", () => {
    useAppStore.getState().openDiffTab("ws-a", "file.ts", "unstaged");
    const before = useAppStore.getState();
    useAppStore.getState().selectWorkspace("ws-a");
    const after = useAppStore.getState();
    expect(after).toBe(before);
  });

  it("saves and restores diff selection on workspace switch", () => {
    useAppStore.getState().openDiffTab("ws-a", "file.ts", "unstaged");
    expect(useAppStore.getState().diffSelectedFile).toBe("file.ts");

    useAppStore.getState().selectWorkspace("ws-b");
    expect(useAppStore.getState().diffSelectedFile).toBeNull();

    useAppStore.getState().selectWorkspace("ws-a");
    expect(useAppStore.getState().diffSelectedFile).toBe("file.ts");
    expect(useAppStore.getState().diffSelectedLayer).toBe("unstaged");
  });

  it("does not restore a dead selection when the tab was closed", () => {
    useAppStore.getState().openDiffTab("ws-a", "file.ts", "unstaged");
    useAppStore.getState().selectWorkspace("ws-b");

    useAppStore.setState({ diffTabsByWorkspace: { "ws-a": [], "ws-b": [] } });

    useAppStore.getState().selectWorkspace("ws-a");
    expect(useAppStore.getState().diffSelectedFile).toBeNull();
  });

  it("preserves diff tabs across workspace switches", () => {
    useAppStore.getState().openDiffTab("ws-a", "a.ts", "staged");
    useAppStore.getState().openDiffTab("ws-a", "b.ts", "unstaged");

    useAppStore.getState().selectWorkspace("ws-b");
    useAppStore.getState().openDiffTab("ws-b", "c.ts", "committed");

    expect(useAppStore.getState().diffTabsByWorkspace["ws-a"]).toHaveLength(2);
    expect(useAppStore.getState().diffTabsByWorkspace["ws-b"]).toHaveLength(1);
  });

  it("does not save selection when outgoing workspace has no active diff", () => {
    useAppStore.getState().selectWorkspace("ws-b");
    expect(useAppStore.getState().diffSelectionByWorkspace["ws-a"]).toBeUndefined();
  });

  it("clears diff content on workspace switch even when restoring selection", () => {
    useAppStore.getState().openDiffTab("ws-a", "file.ts", "unstaged");
    useAppStore.setState({ diffContent: { path: "file.ts", hunks: [], is_binary: false } });

    useAppStore.getState().selectWorkspace("ws-b");
    useAppStore.getState().selectWorkspace("ws-a");

    expect(useAppStore.getState().diffSelectedFile).toBe("file.ts");
    expect(useAppStore.getState().diffContent).toBeNull();
  });
});

// ---------- Diff selection cleanup ----------

describe("diff selection cleanup on removal", () => {
  beforeEach(() => {
    reset();
    useAppStore.setState({
      repositories: [makeRepository("r1")],
      diffSelectionByWorkspace: {
        "ws-a": { path: "a.ts", layer: "unstaged" },
        "ws-b": { path: "b.ts", layer: "staged" },
      },
    });
  });

  it("removeWorkspace cleans up diffSelectionByWorkspace", () => {
    useAppStore.getState().removeWorkspace("ws-a");
    expect(useAppStore.getState().diffSelectionByWorkspace["ws-a"]).toBeUndefined();
    expect(useAppStore.getState().diffSelectionByWorkspace["ws-b"]).toBeDefined();
  });

  it("removeRepository cleans up diffSelectionByWorkspace for all workspaces", () => {
    useAppStore.getState().removeRepository("r1");
    expect(useAppStore.getState().diffSelectionByWorkspace).toEqual({});
  });
});

// ---------- Chat draft persistence ----------

describe("chatDrafts store operations", () => {
  beforeEach(reset);

  it("setChatDraft writes and reads correctly", () => {
    useAppStore.getState().setChatDraft("s-a1", "hello world");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBe("hello world");
  });

  it("setChatDraft overwrites existing draft", () => {
    useAppStore.getState().setChatDraft("s-a1", "first");
    useAppStore.getState().setChatDraft("s-a1", "second");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBe("second");
  });

  it("clearChatDraft removes the draft entry", () => {
    useAppStore.getState().setChatDraft("s-a1", "hello");
    useAppStore.getState().clearChatDraft("s-a1");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBeUndefined();
  });

  it("clearChatDraft is a no-op for missing key", () => {
    const before = useAppStore.getState().chatDrafts;
    useAppStore.getState().clearChatDraft("nonexistent");
    expect(useAppStore.getState().chatDrafts).toBe(before);
  });

  it("drafts are independent per session", () => {
    useAppStore.getState().setChatDraft("s-a1", "draft-a1");
    useAppStore.getState().setChatDraft("s-a2", "draft-a2");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBe("draft-a1");
    expect(useAppStore.getState().chatDrafts["s-a2"]).toBe("draft-a2");
  });
});

// ---------- Chat draft cleanup ----------

describe("chat draft cleanup on removal", () => {
  beforeEach(() => {
    reset();
    useAppStore.setState({
      repositories: [makeRepository("r1")],
      chatDrafts: {
        "s-a1": "draft a1",
        "s-a2": "draft a2",
        "s-b1": "draft b1",
      },
    });
  });

  it("removeChatSession cleans up draft for that session", () => {
    useAppStore.getState().removeChatSession("s-a1");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBeUndefined();
    expect(useAppStore.getState().chatDrafts["s-a2"]).toBe("draft a2");
  });

  it("removeWorkspace cleans up drafts for all sessions in that workspace", () => {
    useAppStore.getState().removeWorkspace("ws-a");
    expect(useAppStore.getState().chatDrafts["s-a1"]).toBeUndefined();
    expect(useAppStore.getState().chatDrafts["s-a2"]).toBeUndefined();
    expect(useAppStore.getState().chatDrafts["s-b1"]).toBe("draft b1");
  });

  it("removeRepository cleans up drafts for all sessions across all workspaces", () => {
    useAppStore.getState().removeRepository("r1");
    expect(useAppStore.getState().chatDrafts).toEqual({});
  });
});

// ---------- clearDiff ----------

describe("clearDiff resets selection map", () => {
  beforeEach(reset);

  it("clears diffSelectionByWorkspace along with other diff state", () => {
    useAppStore.setState({
      diffSelectionByWorkspace: {
        "ws-a": { path: "a.ts", layer: "unstaged" },
      },
    });
    useAppStore.getState().clearDiff();
    expect(useAppStore.getState().diffSelectionByWorkspace).toEqual({});
  });
});
