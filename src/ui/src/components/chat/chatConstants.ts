import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { ChatAttachment } from "../../types/chat";
import type { ConversationCheckpoint } from "../../types/checkpoint";

// Stable empty arrays to avoid Zustand selector re-renders when data is undefined.
// Without these, `?? []` / `|| []` creates a new reference on every store update,
// causing Object.is to return false and triggering unnecessary component re-renders.
export const EMPTY_COMPLETED_TURNS: CompletedTurn[] = [];
export const EMPTY_ACTIVITIES: ToolActivity[] = [];
export const EMPTY_ATTACHMENTS: ChatAttachment[] = [];
export const EMPTY_CHECKPOINTS: ConversationCheckpoint[] = [];

export type RollbackModalData = {
  workspaceId: string;
  sessionId: string;
  checkpointId: string | null;
  messageId: string;
  messagePreview: string;
  messageContent: string;
  hasFileChanges: boolean;
};
