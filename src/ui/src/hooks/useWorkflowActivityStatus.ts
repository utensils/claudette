import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import {
  isWorkflowProgressEntry,
  type WorkflowProgressEntry,
} from "../types/workflow";
import { debugChat } from "../utils/chatDebug";

/** Payload of the `workflow-activity-status` Tauri event. Mirrors
 *  `WorkflowActivityStatusEvent` in `src/agent/workflow_progress.rs`. */
export interface WorkflowActivityStatusPayload {
  workspace_id: string;
  chat_session_id: string;
  tool_use_id: string;
  status: string;
  /** Reconciled tree. `null` means "keep what you have" — the row carried
   *  no readable tree, which must not be confused with "the tree is empty". */
  workflow_progress: WorkflowProgressEntry[] | null;
}

/**
 * Settle a backgrounded `Workflow` run in the live store when Rust reports it
 * has ended.
 *
 * Why this exists as its own channel rather than riding `agent-stream`: the
 * `agent-stream` feed is torn down at every turn's `Result`
 * (`src/agent/session.rs`), and a backgrounded workflow routinely finishes
 * long after the turn that launched it. Its terminal `task_notification`
 * therefore arrives when no per-turn forwarder is attached, so the webview
 * never saw it — the run's status stayed `"running"` and the pill above the
 * composer never went away.
 *
 * **This is not the source of truth.** Rust has already written the terminal
 * status and the reconciled tree to `turn_tool_activities` by the time this
 * event is sent. Applying it here only spares the user a reload; if the
 * owning session isn't hydrated in the store, `updateToolActivity` no-ops and
 * the next hydrate reads the correct row from disk. That ordering is
 * deliberate — persistence must not depend on the webview being awake,
 * which is exactly the coupling that produced the bug.
 *
 * Mounted once, next to `useAgentStream`, so it covers every session rather
 * than only the visible one.
 */
export function useWorkflowActivityStatus() {
  const updateToolActivity = useAppStore((s) => s.updateToolActivity);

  useEffect(() => {
    // Same StrictMode guard as `useAgentStream`: the async unlisten() can't
    // block React's synchronous remount, so a stale listener may briefly
    // coexist with the new one.
    let active = true;
    const unlisten = listen<WorkflowActivityStatusPayload>(
      "workflow-activity-status",
      (event) => {
        if (!active) return;
        const { chat_session_id, tool_use_id, status, workflow_progress } =
          event.payload;
        if (!chat_session_id || !tool_use_id) return;

        const updates: Parameters<typeof updateToolActivity>[2] = {
          agentStatus: status,
        };
        // Validate at the boundary and only on the happy path. A malformed
        // tree is dropped rather than written, so a bad payload degrades to
        // "status applied, tree unchanged" instead of blanking a good card.
        if (
          Array.isArray(workflow_progress) &&
          workflow_progress.every(isWorkflowProgressEntry)
        ) {
          updates.workflowProgress = workflow_progress;
        }
        debugChat("stream", "workflow activity resolved", {
          sessionId: chat_session_id,
          toolUseId: tool_use_id,
          status,
          agents: updates.workflowProgress?.length ?? null,
        });
        updateToolActivity(chat_session_id, tool_use_id, updates);
      },
    );

    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, [updateToolActivity]);
}
