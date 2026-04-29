import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { ChatAttachment } from "../../types/chat";
import type { ConversationCheckpoint } from "../../types/checkpoint";

// Stable empty arrays to avoid Zustand selector re-renders when data is undefined.
// Without these, `?? []` / `|| []` creates a new reference on every store update,
// causing Object.is to return false and triggering unnecessary component re-renders.
//
// Frozen + typed `readonly` so an accidental `.push` in any consumer would fail
// loudly at compile time and at runtime, instead of silently poisoning every
// other consumer that shares the same module-level reference.
export const EMPTY_COMPLETED_TURNS: readonly CompletedTurn[] = Object.freeze([]);
export const EMPTY_ACTIVITIES: readonly ToolActivity[] = Object.freeze([]);
export const EMPTY_ATTACHMENTS: readonly ChatAttachment[] = Object.freeze([]);
export const EMPTY_CHECKPOINTS: readonly ConversationCheckpoint[] = Object.freeze([]);

export type RollbackModalData = {
  workspaceId: string;
  sessionId: string;
  checkpointId: string | null;
  messageId: string;
  messagePreview: string;
  messageContent: string;
  hasFileChanges: boolean;
};
