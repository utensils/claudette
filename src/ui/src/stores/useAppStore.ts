import { create } from "zustand";
import {
  createAgentInteractionSlice,
  type AgentApproval,
  type AgentApprovalDetail,
  type AgentApprovalKind,
  type AgentInteractionSlice,
  type AgentQuestion,
  type AgentQuestionItem,
  type ChatSearchState,
  type PlanApproval,
  type QueuedMessage,
} from "./slices/agentInteractionSlice";
import {
  createChatSessionsSlice,
  type ChatSessionsSlice,
} from "./slices/chatSessionsSlice";
import {
  createChatSlice,
  type ChatSlice,
  type AgentToolCall,
  type CompletedTurn,
  type ToolActivity,
  type TurnUsage,
} from "./slices/chatSlice";
import {
  createCheckpointsSlice,
  type CheckpointsSlice,
} from "./slices/checkpointsSlice";
import { createDiffSlice, type DiffSlice } from "./slices/diffSlice";
import {
  createFileTreeSlice,
  type FileTreeSlice,
} from "./slices/fileTreeSlice";
import {
  createNotificationsSlice,
  type NotificationsSlice,
} from "./slices/notificationsSlice";
import {
  createPermissionsSlice,
  type PermissionLevel,
  type PermissionsSlice,
} from "./slices/permissionsSlice";
import {
  createRepositoriesSlice,
  type RepositoriesSlice,
} from "./slices/repositoriesSlice";
import { createRemoteSlice, type RemoteSlice } from "./slices/remoteSlice";
import { createScmSlice, type ScmSlice } from "./slices/scmSlice";
import {
  createPinnedPromptsSlice,
  type PinnedPromptsSlice,
} from "./slices/pinnedPromptsSlice";
import {
  createSettingsSlice,
  type SettingsSlice,
} from "./slices/settingsSlice";
import { createSystemSlice, type SystemSlice } from "./slices/systemSlice";
import {
  createTabOrderSlice,
  type TabOrderSlice,
} from "./slices/tabOrderSlice";
import {
  createTerminalSlice,
  type TerminalSlice,
} from "./slices/terminalSlice";
import { createToolbarSlice, type ToolbarSlice } from "./slices/toolbarSlice";
import { createUiSlice, type UiSlice } from "./slices/uiSlice";
import {
  createWorkspacesSlice,
  type WorkspacesSlice,
} from "./slices/workspacesSlice";
import {
  createWorkspaceClaudeFlagsSlice,
  type WorkspaceClaudeFlagsSlice,
} from "./slices/workspaceClaudeFlagsSlice";

export type {
  AgentApproval,
  AgentApprovalDetail,
  AgentApprovalKind,
  AgentQuestion,
  AgentQuestionItem,
  AgentToolCall,
  ChatSearchState,
  CompletedTurn,
  PermissionLevel,
  PlanApproval,
  QueuedMessage,
  ToolActivity,
  TurnUsage,
};

export type AppState = RepositoriesSlice &
  WorkspacesSlice &
  ChatSessionsSlice &
  ChatSlice &
  AgentInteractionSlice &
  CheckpointsSlice &
  NotificationsSlice &
  ToolbarSlice &
  PermissionsSlice &
  DiffSlice &
  FileTreeSlice &
  TerminalSlice &
  ScmSlice &
  UiSlice &
  PinnedPromptsSlice &
  SettingsSlice &
  RemoteSlice &
  SystemSlice &
  TabOrderSlice &
  WorkspaceClaudeFlagsSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createRepositoriesSlice(...a),
  ...createWorkspacesSlice(...a),
  ...createChatSessionsSlice(...a),
  ...createChatSlice(...a),
  ...createAgentInteractionSlice(...a),
  ...createCheckpointsSlice(...a),
  ...createNotificationsSlice(...a),
  ...createToolbarSlice(...a),
  ...createPermissionsSlice(...a),
  ...createDiffSlice(...a),
  ...createFileTreeSlice(...a),
  ...createTerminalSlice(...a),
  ...createScmSlice(...a),
  ...createUiSlice(...a),
  ...createPinnedPromptsSlice(...a),
  ...createSettingsSlice(...a),
  ...createRemoteSlice(...a),
  ...createSystemSlice(...a),
  ...createTabOrderSlice(...a),
  ...createWorkspaceClaudeFlagsSlice(...a),
}));

/**
 * Returns the session id currently selected inside the active workspace.
 * Null when no workspace is selected or when that workspace has no active
 * session yet (e.g. the sessions list is still loading).
 */
export const selectActiveSessionId = (s: AppState): string | null => {
  const wsId = s.selectedWorkspaceId;
  if (!wsId) return null;
  return s.selectedSessionIdByWorkspaceId[wsId] ?? null;
};

/**
 * Returns the path of the file tab currently active in the active workspace,
 * or `null` if no file tab is active there. AppLayout uses this to decide
 * whether to render the FileViewer.
 */
export const selectActiveFileTabPath = (s: AppState): string | null => {
  const wsId = s.selectedWorkspaceId;
  if (!wsId) return null;
  return s.activeFileTabByWorkspace[wsId] ?? null;
};

// Expose store on window in dev builds for debug_eval_js access.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_STORE__ =
    useAppStore;
}
