// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import type { ChatMessage, ChatSession, Repository, Workspace } from "../../types";
import { ChatPanel } from "./ChatPanel";

const serviceMocks = vi.hoisted(() => ({
  clearConversation: vi.fn(),
  forkWorkspaceAtCheckpoint: vi.fn(),
  getAppSetting: vi.fn(() => Promise.resolve(null)),
  launchCodexLogin: vi.fn(),
  listCheckpoints: vi.fn(() => Promise.resolve([])),
  listSlashCommands: vi.fn(() => Promise.resolve([])),
  loadAttachmentData: vi.fn(),
  loadAttachmentsForSession: vi.fn(() => Promise.resolve([])),
  loadChatHistoryPage: vi.fn(() =>
    Promise.resolve({
      messages: [],
      attachments: [],
      has_more: false,
      total_count: 0,
    }),
  ),
  loadCompletedTurns: vi.fn(() => Promise.resolve([])),
  loadDiffFiles: vi.fn(),
  openReleaseNotes: vi.fn(),
  openUsageSettings: vi.fn(),
  readPlanFile: vi.fn(),
  recordSlashCommandUsage: vi.fn(),
  sendRemoteCommand: vi.fn(),
  setAppSetting: vi.fn(),
  steerQueuedChatMessage: vi.fn(),
  stopAgent: vi.fn(),
  submitAgentAnswer: vi.fn(),
  submitAgentApproval: vi.fn(),
  submitPlanApproval: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) =>
      typeof fallbackOrOptions === "string" ? fallbackOrOptions : key,
  }),
}));

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return {
    ...actual,
    ...serviceMocks,
  };
});

vi.mock("../../hooks/useStickyScroll", () => ({
  useStickyScroll: () => ({
    isAtBottom: true,
    scrollToBottom: vi.fn(),
    restoreScrollPosition: vi.fn(),
    handleContentChanged: vi.fn(),
    markUserScrollIntent: vi.fn(),
    suppressNextAutoScrollRef: { current: false },
  }),
}));

vi.mock("../../hooks/usePreventScrollBounce", () => ({
  usePreventScrollBounce: vi.fn(),
}));

vi.mock("../shared/WorkspacePanelHeader", () => ({
  WorkspacePanelHeader: () => <div data-testid="workspace-header" />,
}));

vi.mock("./SessionTabs", () => ({
  SessionTabs: () => <div data-testid="session-tabs" />,
}));

vi.mock("./WorkspaceEmptyTabs", () => ({
  WorkspaceEmptyTabs: () => <div data-testid="workspace-empty-tabs" />,
}));

vi.mock("./OverlayScrollbar", () => ({
  OverlayScrollbar: () => null,
}));

vi.mock("./ChatSearchBar", () => ({
  ChatSearchBar: () => null,
}));

vi.mock("./ScrollToBottomPill", () => ({
  ScrollToBottomPill: () => null,
}));

vi.mock("./ChatInputArea", () => ({
  ChatInputArea: () => <div data-testid="composer" />,
}));

vi.mock("./ChatEmptyState", () => ({
  ChatEmptyState: () => (
    <div data-testid="empty-state">Send a message to start a conversation</div>
  ),
}));

vi.mock("./StreamingMessage", () => ({
  StreamingMessage: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="streaming-message">streaming:{sessionId}</div>
  ),
}));

vi.mock("./StreamingThinkingBlock", () => ({
  StreamingThinkingBlock: () => <div data-testid="streaming-thinking" />,
}));

vi.mock("./CurrentTurnTaskProgress", () => ({
  CurrentTurnTaskProgress: () => <div data-testid="task-progress" />,
}));

vi.mock("./CliInvocationBanner", () => ({
  CliInvocationBanner: () => null,
}));

vi.mock("./AgentQuestionCard", () => ({
  AgentQuestionCard: () => null,
}));

vi.mock("./PlanApprovalCard", () => ({
  PlanApprovalCard: () => null,
}));

vi.mock("./AgentApprovalCard", () => ({
  AgentApprovalCard: () => null,
}));

vi.mock("./ChatErrorBanner", () => ({
  ChatErrorBanner: () => null,
}));

vi.mock("../auth/ChatAuthFailureCallout", () => ({
  ChatAuthFailureCallout: () => null,
}));

vi.mock("./SetupScriptBanner", () => ({
  SetupScriptBanner: () => null,
}));

vi.mock("./AttachmentContextMenu", () => ({
  AttachmentContextMenu: () => null,
}));

vi.mock("./AttachmentLightbox", () => ({
  AttachmentLightbox: () => null,
}));

vi.mock("./MessagesWithTurns", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    MessagesWithTurns: ({
      messages,
      sessionId,
      streamingMessageNode,
    }: {
      messages: ChatMessage[];
      sessionId: string;
      streamingMessageNode?: React.ReactNode;
    }) => {
      const [initialMessages] = React.useState(messages);
      return (
        <div data-testid="messages-with-turns" data-session-id={sessionId}>
          {initialMessages.map((message) => (
            <div key={message.id}>{message.content}</div>
          ))}
          {streamingMessageNode}
        </div>
      );
    },
  };
});

const WORKSPACE_ID = "workspace-1";
const SESSION_WITH_MESSAGES = "session-with-messages";
const NEW_SESSION = "new-session";

let root: Root | null = null;
let container: HTMLElement | null = null;

function makeWorkspace(): Workspace {
  return {
    id: WORKSPACE_ID,
    repository_id: "repo-1",
    name: "Workspace",
    worktree_path: "/repo",
    branch_name: "main",
    status: "Active",
    status_line: "",
    created_at: "2026-05-20T00:00:00.000Z",
    sort_order: 0,
    remote_connection_id: null,
    agent_status: "Idle",
  };
}

function makeRepository(): Repository {
  return {
    id: "repo-1",
    name: "Repo",
    path: "/repo",
    path_slug: "repo",
    icon: null,
    created_at: "2026-05-20T00:00:00.000Z",
    setup_script: null,
    custom_instructions: null,
    sort_order: 0,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    archive_script: null,
    archive_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    remote_connection_id: null,
  };
}

function makeSession(id: string, name: string): ChatSession {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    session_id: null,
    name,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "2026-05-20T00:00:00.000Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

function makeMessage(sessionId: string, content: string): ChatMessage {
  return {
    id: `${sessionId}-message`,
    workspace_id: WORKSPACE_ID,
    chat_session_id: sessionId,
    role: "Assistant",
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "2026-05-20T00:00:00.000Z",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

async function renderChatPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPanel />);
  });
}

beforeEach(() => {
  serviceMocks.getAppSetting.mockClear();
  serviceMocks.loadChatHistoryPage.mockClear();
  serviceMocks.listCheckpoints.mockClear();
  serviceMocks.loadCompletedTurns.mockClear();
  useAppStore.setState({
    workspaces: [makeWorkspace()],
    repositories: [makeRepository()],
    selectedWorkspaceId: WORKSPACE_ID,
    sessionsByWorkspace: {
      [WORKSPACE_ID]: [
        makeSession(SESSION_WITH_MESSAGES, "Existing chat"),
        makeSession(NEW_SESSION, "New chat"),
      ],
    },
    selectedSessionIdByWorkspaceId: {
      [WORKSPACE_ID]: SESSION_WITH_MESSAGES,
    },
    sessionsLoadedByWorkspace: {
      [WORKSPACE_ID]: true,
    },
    chatMessages: {
      [SESSION_WITH_MESSAGES]: [
        makeMessage(SESSION_WITH_MESSAGES, "old transcript should disappear"),
      ],
      [NEW_SESSION]: [],
    },
    chatPagination: {
      [SESSION_WITH_MESSAGES]: {
        hasMore: false,
        isLoadingMore: false,
        totalCount: 1,
        oldestMessageId: `${SESSION_WITH_MESSAGES}-message`,
      },
      [NEW_SESSION]: {
        hasMore: false,
        isLoadingMore: false,
        totalCount: 0,
        oldestMessageId: null,
      },
    },
    streamingContent: {},
    streamingThinking: {},
    pendingTypewriter: {},
    completedTurns: {},
    toolActivities: {},
    runningSetupScripts: {},
    queuedMessages: {},
    diffTabsByWorkspace: {},
    fileTabsByWorkspace: {},
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("ChatPanel transcript session switches", () => {
  it("remounts the transcript subtree so a new session cannot show stale messages", async () => {
    await renderChatPanel();
    expect(container?.textContent).toContain("old transcript should disappear");

    await act(async () => {
      useAppStore.setState((state) => ({
        selectedSessionIdByWorkspaceId: {
          ...state.selectedSessionIdByWorkspaceId,
          [WORKSPACE_ID]: NEW_SESSION,
        },
        streamingContent: {
          ...state.streamingContent,
          [NEW_SESSION]: "new session stream",
        },
      }));
    });

    expect(container?.textContent).not.toContain("old transcript should disappear");
    expect(container?.textContent).toContain(`streaming:${NEW_SESSION}`);
  });

  it("renders an empty new chat without the previous session transcript", async () => {
    await renderChatPanel();

    await act(async () => {
      useAppStore.getState().selectSession(WORKSPACE_ID, NEW_SESSION);
    });

    expect(container?.textContent).not.toContain("old transcript should disappear");
    expect(container?.textContent).toContain(
      "Send a message to start a conversation",
    );
  });
});
