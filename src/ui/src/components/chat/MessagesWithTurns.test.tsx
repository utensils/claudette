// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore, type CompletedTurn, type ToolActivity } from "../../stores/useAppStore";
import type { ChatMessage } from "../../types/chat";
import { MessagesWithTurns } from "./MessagesWithTurns";

const serviceMocks = vi.hoisted(() => ({
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

    expect(container.textContent).toContain("mcp__postgres__query");
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

    const link = Array.from(container.querySelectorAll("a")).find(
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
