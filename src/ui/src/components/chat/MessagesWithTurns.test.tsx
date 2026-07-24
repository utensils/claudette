// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore, type CompletedTurn, type ToolActivity } from "../../stores/useAppStore";
import type { AgentConclusion, ChatMessage } from "../../types/chat";
import { MessagesWithTurns } from "./MessagesWithTurns";

const serviceMocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  listWorkspaceFiles: vi.fn(() => Promise.resolve([])),
  openUrl: vi.fn(() => Promise.resolve()),
  loadAttachmentData: vi.fn(),
  getClaudeAuthStatus: vi.fn(() =>
    Promise.resolve({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: "Not logged in",
    }),
  ),
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
  submitClaudeAuthCode: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: serviceMocks.invoke,
}));

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return {
    ...actual,
    ...serviceMocks,
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "session-1";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    chat_session_id: SESSION_ID,
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "2026-05-08T00:00:00.000Z",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

function activity(toolName: string): ToolActivity {
  return {
    toolUseId: `${toolName}-1`,
    toolName,
    inputJson: JSON.stringify({ query: "select 1" }),
    resultText: "1 row",
    collapsed: true,
    summary: "1 row",
  };
}

function completedTurn(activities: ToolActivity[]): CompletedTurn {
  return {
    id: "turn-1",
    activities,
    messageCount: 2,
    collapsed: false,
    afterMessageIndex: 2,
  };
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

beforeEach(() => {
  serviceMocks.invoke.mockClear();
  serviceMocks.listWorkspaceFiles.mockClear();
  serviceMocks.listWorkspaceFiles.mockResolvedValue([]);
  serviceMocks.openUrl.mockClear();
  serviceMocks.claudeAuthLogin.mockClear();
  serviceMocks.getClaudeAuthStatus.mockClear();
  serviceMocks.getClaudeAuthStatus.mockResolvedValue({
    state: "signed_out",
    loggedIn: false,
    verified: false,
    authMethod: null,
    apiProvider: null,
    message: "Not logged in",
  });
  useAppStore.setState({
    workspaces: [
      {
        id: WORKSPACE_ID,
        repository_id: "repo-1",
        name: "Workspace",
        worktree_path: "/repo",
        branch_name: "main",
        status: "Active",
        status_line: "",
        created_at: "2026-05-08T00:00:00.000Z",
        sort_order: 0,
        input_values: null,
        remote_connection_id: null,
        agent_status: "Idle",
      },
    ],
    chatMessages: {},
    chatAttachments: {},
    chatPagination: {},
    completedTurns: {},
    toolActivities: {},
    collapsedToolGroupsBySession: {},
    checkpoints: {},
    claudeAuthFailure: null,
    resolvedClaudeAuthFailureMessageId: null,
    diffFiles: [],
    diffMergeBase: "base-sha",
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("MessagesWithTurns edit summaries", () => {
  it("renders persisted thinking blocks with the shared ThinkingBlock surface", async () => {
    const assistant = message("assistant-1", "Assistant", "Done.");
    assistant.thinking = "I should check the existing renderer first.";
    useAppStore.setState({
      showThinkingBlocks: { [SESSION_ID]: true },
    });

    const container = await render(
      <MessagesWithTurns
        messages={[message("user-1", "User", "Update it"), assistant]}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Done.");
    const thinkingToggle = container.querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement | null;
    expect(thinkingToggle?.textContent).toContain("Thinking");
  });

  it("does not show workspace dirty files for a non-editing session turn", async () => {
    const messages = [
      message("user-1", "User", "Query production data"),
      message("assistant-1", "Assistant", "The query returned one row."),
    ];
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [completedTurn([activity("mcp__postgres__query")])],
      },
      diffFiles: [
        {
          path: "src/dirty-from-other-session.ts",
          status: "Modified",
          additions: 8,
          deletions: 3,
        },
      ],
    });

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    // The MCP call renders in a per-server container (header "postgres")
    // with the redundant `mcp__<server>__` prefix stripped from the row.
    expect(container.textContent).toContain("postgres");
    expect(container.textContent).not.toContain("mcp__postgres__query");
    expect(container.textContent).not.toContain("1 file changed");
    expect(container.textContent).not.toContain("dirty-from-other-session.ts");
  });

  it("renders auth failures as an inline sign-in panel", async () => {
    const messages = [
      message("user-1", "User", "ping"),
      message(
        "assistant-1",
        "Assistant",
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("auth_panel_title");
    expect(container.textContent).toContain(
      "Invalid authentication credentials (401)",
    );
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("auth_sign_in"),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(serviceMocks.claudeAuthLogin).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().claudeAuthFailure).toEqual({
      messageId: "assistant-1",
      error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    });
  });

  it("opens agent-mentioned file names in the Monaco file tab", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "README.md", is_directory: false },
    ] as never);
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 1 },
    });
    const messages = [
      message("user-1", "User", "what changed?"),
      message("assistant-1", "Assistant", "I updated README.md for you."),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const link = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "README.md",
    );
    expect(link).toBeTruthy();

    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toEqual(["README.md"]);
    expect(state.activeFileTabByWorkspace[WORKSPACE_ID]).toBe("README.md");
  });

  it("does not link unresolved agent-mentioned file names", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "CHANGELOG.md", is_directory: false },
    ] as never);
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 2 },
    });
    const messages = [
      message("user-1", "User", "what changed?"),
      message("assistant-1", "Assistant", "I updated README.md for you."),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const link = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "README.md",
    );
    expect(link).toBeUndefined();
    expect(container.textContent).toContain("README.md");
  });

  it("opens resolved at-sign file mentions in user messages", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "README.md", is_directory: false },
    ] as never);
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 1 },
    });
    const messages = [
      message("user-1", "User", "make a simple edit to @README.md"),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const link = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "@README.md",
    );
    expect(link).toBeTruthy();

    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toEqual(["README.md"]);
    expect(state.activeFileTabByWorkspace[WORKSPACE_ID]).toBe("README.md");
  });

  it("does not link unresolved at-sign mentions in user messages", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "README.md", is_directory: false },
    ] as never);
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 2 },
    });
    const messages = [
      message("user-1", "User", "ask @alice about dev@example.com"),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("button.cc-file-path-link")).toBeNull();
  });

  it("does not open home-relative file links as Monaco tabs", async () => {
    const messages = [
      message("user-1", "User", "where is it?"),
      message("assistant-1", "Assistant", "Saved to ~/Downloads/report.md."),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    const link = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "~/Downloads/report.md",
    );
    expect(link).toBeUndefined();

    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toBeUndefined();
    expect(serviceMocks.invoke).not.toHaveBeenCalledWith(
      "open_in_editor",
      expect.anything(),
    );
    expect(serviceMocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens localhost file URLs from agent output in Monaco without navigating", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "README.md", is_directory: false },
    ] as never);
    const worktreePath =
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger";
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 3 },
      workspaces: [
        {
          ...useAppStore.getState().workspaces[0],
          worktree_path: worktreePath,
        },
      ],
    });
    const messages = [
      message("user-1", "User", "where did you write?"),
      message(
        "assistant-1",
        "Assistant",
        `Wrote http://localhost:14254${worktreePath}/README.md:8`,
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const fileButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("README.md"),
    );
    expect(fileButton).toBeTruthy();
    expect(fileButton?.textContent).toBe("README.md:8");
    expect(container.querySelector('a[href^="http://localhost:14254"]')).toBeNull();

    await act(async () => {
      fileButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toEqual(["README.md"]);
    expect(state.activeFileTabByWorkspace[WORKSPACE_ID]).toBe("README.md");
    expect(state.fileRevealTargetByWorkspace[WORKSPACE_ID]).toMatchObject({
      path: "README.md",
      startLine: 8,
      endLine: 8,
    });
  });

  it("opens multiple file links from one agent message without dropping prior tabs", async () => {
    serviceMocks.listWorkspaceFiles.mockResolvedValue([
      { path: "README.md", is_directory: false },
      { path: "simple-wave.svg", is_directory: false },
    ] as never);
    const worktreePath =
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger";
    useAppStore.setState({
      fileTreeRefreshNonceByWorkspace: { [WORKSPACE_ID]: 4 },
      workspaces: [
        {
          ...useAppStore.getState().workspaces[0],
          worktree_path: worktreePath,
        },
      ],
    });
    const messages = [
      message(
        "assistant-1",
        "Assistant",
        `Edited http://localhost:14254${worktreePath}/README.md:8 and http://localhost:14254${worktreePath}/simple-wave.svg:1`,
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const readmeButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "README.md:8",
    );
    const svgButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "simple-wave.svg:1",
    );
    expect(readmeButton).toBeTruthy();
    expect(svgButton).toBeTruthy();

    await act(async () => {
      readmeButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      svgButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toEqual([
      "README.md",
      "simple-wave.svg",
    ]);
    expect(state.activeFileTabByWorkspace[WORKSPACE_ID]).toBe("simple-wave.svg");
    expect(state.fileRevealTargetByWorkspace[WORKSPACE_ID]).toMatchObject({
      path: "simple-wave.svg",
      startLine: 1,
      endLine: 1,
    });
  });

  it("reopens a chat file link after its Monaco tab was closed", async () => {
    const worktreePath =
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger";
    useAppStore.setState({
      workspaces: [
        {
          ...useAppStore.getState().workspaces[0],
          worktree_path: worktreePath,
        },
      ],
    });
    const messages = [
      message(
        "assistant-1",
        "Assistant",
        `See http://localhost:14254${worktreePath}/README.md:8`,
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    const fileButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "README.md:8",
    );
    expect(fileButton).toBeTruthy();

    await act(async () => {
      fileButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    useAppStore.getState().closeFileTab(WORKSPACE_ID, "README.md");
    expect(useAppStore.getState().fileTabsByWorkspace[WORKSPACE_ID]).toEqual([]);
    expect(useAppStore.getState().activeFileTabByWorkspace[WORKSPACE_ID]).toBeNull();

    await act(async () => {
      fileButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WORKSPACE_ID]).toEqual(["README.md"]);
    expect(state.activeFileTabByWorkspace[WORKSPACE_ID]).toBe("README.md");
    expect(state.fileRevealTargetByWorkspace[WORKSPACE_ID]).toMatchObject({
      path: "README.md",
      startLine: 8,
      endLine: 8,
    });
  });

  it("renders Claude CLI slash-login failures as a sign-in callout", async () => {
    const messages = [
      message("user-1", "User", "ping"),
      message("assistant-1", "Assistant", "Not logged in · Please run /login"),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("auth_panel_title");
    expect(container.textContent).toContain("Not logged in");
    expect(container.textContent).not.toContain("Please run /login");
  });

  it("shows only the latest repeated auth failure as the sign-in callout", async () => {
    const messages = [
      message("user-1", "User", "Explore this project"),
      message(
        "assistant-1",
        "Assistant",
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
      message("user-2", "User", "ping"),
      message(
        "assistant-2",
        "Assistant",
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    const authButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.includes("auth_sign_in"),
    );
    expect(authButtons).toHaveLength(1);
    expect(
      container.textContent?.match(/auth_panel_title/g) ?? [],
    ).toHaveLength(1);
    expect(container.textContent).toContain(
      "Invalid authentication credentials (401)",
    );
  });

  it("renders a resolved auth failure as a recovery marker without stale error text", async () => {
    useAppStore.setState({
      resolvedClaudeAuthFailureMessageId: "assistant-1",
    });
    const messages = [
      message("user-1", "User", "ping"),
      message(
        "assistant-1",
        "Assistant",
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ];

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("auth_resolved_label");
    expect(container.textContent).toContain("auth_resolved_message");
    expect(container.textContent).not.toContain(
      "Invalid authentication credentials (401)",
    );
    expect(container.textContent).not.toContain("auth_panel_title");
  });

  it("still shows files parsed from this turn's own edit activity", async () => {
    const messages = [
      message("user-1", "User", "Update the app"),
      message("assistant-1", "Assistant", "Updated."),
    ];
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          completedTurn([
            {
              ...activity("Edit"),
              inputJson: JSON.stringify({
                file_path: "/repo/src/app.ts",
                old_string: "old",
                new_string: "new",
              }),
            },
          ]),
        ],
      },
      diffFiles: [
        {
          path: "src/dirty-from-other-session.ts",
          status: "Modified",
          additions: 8,
          deletions: 3,
        },
      ],
    });

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent).not.toContain("dirty-from-other-session.ts");
  });
});

describe("MessagesWithTurns conclusion gating", () => {
  function conclusion(summary: string): AgentConclusion {
    return {
      id: "conclusion-1",
      chat_session_id: SESSION_ID,
      workspace_id: WORKSPACE_ID,
      // Anchored to the user message that triggered the turn; routes to the
      // turn's assistant message for rendering (see conclusionsByMessage).
      message_id: "user-1",
      title: null,
      summary,
      artifacts: [],
      created_at: "2026-05-08T00:00:00.000Z",
    };
  }

  const messages = [
    message("user-1", "User", "Wrap it up"),
    message("assistant-1", "Assistant", "On it."),
  ];

  it("renders conclusion cards when the Claudette MCP flag is on", async () => {
    useAppStore.setState({
      claudetteMcpEnabled: true,
      chatConclusions: { [SESSION_ID]: [conclusion("Shipped the migration.")] },
    });

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).toContain("Shipped the migration.");
  });

  it("hides already-loaded conclusion cards when the flag is off", async () => {
    // Mirrors flipping the experimental flag off mid-session: the conclusions
    // are still in the store, but the feature must stay fully dark.
    useAppStore.setState({
      claudetteMcpEnabled: false,
      chatConclusions: { [SESSION_ID]: [conclusion("Shipped the migration.")] },
    });

    const container = await render(
      <MessagesWithTurns
        messages={messages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );

    expect(container.textContent).not.toContain("Shipped the migration.");
  });
});

describe("MessagesWithTurns workflow groups", () => {
  const WORKFLOW_SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review the diff across dimensions',
  phases: [{ title: 'Review' }],
}`;

  // One done + one errored: both are terminal, so the badge reads "2/2 agents"
  // alongside "1 failed". Two agents (rather than one) keeps the count badge
  // distinguishable from the failure badge in the collapsed assertions below.
  function workflowActivity(): ToolActivity {
    return {
      toolUseId: "toolu_wf1",
      toolName: "Workflow",
      inputJson: JSON.stringify({ script: WORKFLOW_SCRIPT }),
      // A workflow's tool_result lands at LAUNCH, not completion.
      resultText: "Workflow launched in background. Task ID: w4stpeffj",
      collapsed: false,
      summary: "review-changes",
      agentStatus: "completed",
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Review" },
        {
          type: "workflow_agent",
          index: 1,
          label: "review:bugs",
          state: "done",
          phaseTitle: "Review",
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "review:perf",
          state: "error",
          phaseTitle: "Review",
        },
      ],
    };
  }

  const workflowMessages = [
    message("user-1", "User", "Review the diff"),
    message("assistant-1", "Assistant", "Launched a workflow."),
  ];

  async function renderWorkflowTurn(turn: CompletedTurn): Promise<HTMLElement> {
    useAppStore.setState({ completedTurns: { [SESSION_ID]: [turn] } });
    return render(
      <MessagesWithTurns
        messages={workflowMessages}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        isRunning={false}
        searchQuery=""
        toolDisplayMode="grouped"
      />,
    );
  }

  it("renders a finished workflow expanded even when its turn is collapsed", async () => {
    // `turn.collapsed` defaults true for ordinary tool groups. A workflow must
    // not inherit that: the card was expanded the whole time it was running,
    // and folding it the instant the turn ends reverses what the user saw.
    const container = await renderWorkflowTurn({
      ...completedTurn([workflowActivity()]),
      collapsed: true,
    });

    expect(container.textContent).toContain("review:bugs");
    expect(container.textContent).toContain("review:perf");
  });

  it("keeps the header, badges, and rail visible when the card is collapsed", async () => {
    // The regression this guards: collapse used to be spent on the enclosing
    // TurnSummary chevron, which unmounted the entire card — so the finished
    // run's agent count and failure badge vanished, which is precisely the
    // summary someone collapsing a completed workflow wants to keep.
    useAppStore.setState({
      collapsedToolGroupsBySession: {
        [SESSION_ID]: { "workflow:toolu_wf1": true },
      },
    });
    const container = await renderWorkflowTurn(
      completedTurn([workflowActivity()]),
    );

    expect(container.textContent).toContain("2/2 agents");
    expect(container.textContent).toContain("1 failed");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    // Only the agent tree is hidden.
    expect(container.textContent).not.toContain("review:bugs");
  });

  it("gives the group exactly one collapse control, on the card itself", async () => {
    const container = await renderWorkflowTurn(
      completedTurn([workflowActivity()]),
    );

    // No generic TurnSummary chevron wrapping the card — otherwise the run
    // would render two stacked chevrons meaning two different things.
    expect(container.querySelectorAll("[class*=turnHeader]")).toHaveLength(0);
    const cardHeader = container.querySelector(
      '[role="button"][aria-label*="workflow review-changes"]',
    );
    expect(cardHeader).not.toBeNull();
    expect(cardHeader?.getAttribute("aria-expanded")).toBe("true");
  });

  it("persists a card collapse under the same key the live card uses", async () => {
    const container = await renderWorkflowTurn(
      completedTurn([workflowActivity()]),
    );
    const cardHeader = container.querySelector(
      '[role="button"][aria-label*="workflow review-changes"]',
    ) as HTMLElement;

    await act(async () => {
      cardHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // `workflow:<toolUseId>` — the key `GroupedWorkflowActivity` writes while
    // the run is live, so the choice carries across the turn boundary.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[SESSION_ID]?.[
        "workflow:toolu_wf1"
      ],
    ).toBe(true);
    expect(container.textContent).not.toContain("review:bugs");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });
});
