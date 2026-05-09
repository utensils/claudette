// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore, type CompletedTurn, type ToolActivity } from "../../stores/useAppStore";
import type { ChatMessage } from "../../types/chat";
import { MessagesWithTurns } from "./MessagesWithTurns";

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
