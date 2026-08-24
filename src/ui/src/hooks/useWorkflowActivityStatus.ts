import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import { findToolActivity } from "../stores/findToolActivity";
import { updateTurnToolActivityProgress } from "../services/tauri";
import {
  isWorkflowProgressEntry,
  reconcileAgentStatesOnTerminal,
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
        const incoming =
          Array.isArray(workflow_progress) &&
          workflow_progress.every(isWorkflowProgressEntry)
            ? workflow_progress
            : null;

        // The live tree wins over the one in the payload. Rust reconciled the
        // *checkpointed* row, which is a snapshot from seconds after launch and
        // is frequently `[]` — a workflow's `tool_result` lands within a second
        // of the turn being saved, while every `task_progress` tick since has
        // gone only to this store. Taking the payload's tree verbatim would
        // blank or rewind a rich card, and `useAgentStream`'s handler for the
        // same notification would then persist the downgraded copy back to the
        // row. Reconcile the live tree locally instead; fall back to the
        // payload's when this window never saw the run's ticks.
        const live = findToolActivity(
          useAppStore.getState(),
          chat_session_id,
          tool_use_id,
        )?.workflowProgress;
        const base = live && live.length > 0 ? live : incoming;
        if (base) {
          updates.workflowProgress = reconcileAgentStatesOnTerminal(
            base,
            status,
          );
        }
        debugChat("stream", "workflow activity resolved", {
          sessionId: chat_session_id,
          toolUseId: tool_use_id,
          status,
          agents: updates.workflowProgress?.length ?? null,
        });
        updateToolActivity(chat_session_id, tool_use_id, updates);

        // Write the live tree back when it is the one that survived above.
        // Rust has already recorded the terminal status, so the pill is
        // safe either way — but on the background-wake path this event is
        // the *only* webview notification for the run: the wake loop
        // consumes the `task_notification` without forwarding it, so
        // `useAgentStream`'s persistence handler never fires. Without this
        // the row keeps Rust's checkpoint-era tree (often `[]`), and a card
        // that looked right all session regresses on the next reload.
        //
        // Skipped when the payload's tree is the one we used: that is
        // already exactly what Rust wrote.
        if (live && live.length > 0 && updates.workflowProgress) {
          void updateTurnToolActivityProgress(
            tool_use_id,
            JSON.stringify(updates.workflowProgress),
            status,
            chat_session_id,
          ).catch((err) => {
            debugChat("stream", "persist resolved workflow tree failed", {
              toolUseId: tool_use_id,
              error: String(err),
            });
          });
        }
      },
    );

    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, [updateToolActivity]);
}
