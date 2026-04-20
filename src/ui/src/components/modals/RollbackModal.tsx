import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  rollbackToCheckpoint,
  clearConversation,
  loadDiffFiles,
  loadCompletedTurns,
  loadAttachmentsForSession,
  loadAttachmentData,
} from "../../services/tauri";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RollbackModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const rollbackConversation = useAppStore((s) => s.rollbackConversation);
  const setChatInputPrefill = useAppStore((s) => s.setChatInputPrefill);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const clearDiff = useAppStore((s) => s.clearDiff);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);

  const workspaceId = modalData.workspaceId as string;
  const sessionId = modalData.sessionId as string;
  const checkpointId = (modalData.checkpointId as string) ?? null;
  const messageId = (modalData.messageId as string) ?? null;
  const messagePreview = modalData.messagePreview as string;
  const messageContent = (modalData.messageContent as string) ?? "";
  const hasFileChanges = modalData.hasFileChanges as boolean;
  const isClearAll = !checkpointId;

  const handleRollback = async () => {
    setLoading(true);
    try {
      // Capture the rolled-back message's attachments BEFORE the rollback
      // deletes them from the DB (FK cascade). We'll prefill them into the
      // input so the user can re-send with the same files.
      const rolledBackAtts = messageId
        ? (useAppStore.getState().chatAttachments[sessionId] ?? []).filter(
            (a) => a.message_id === messageId,
          )
        : [];

      const messages = isClearAll
        ? await clearConversation(sessionId, restoreFiles)
        : await rollbackToCheckpoint(sessionId, checkpointId, restoreFiles);
      rollbackConversation(
        sessionId,
        workspaceId,
        checkpointId ?? "__clear__",
        messages,
      );
      // Reload surviving completed turns so tool sections persist.
      loadCompletedTurns(sessionId)
        .then((turnData) => {
          const turns = reconstructCompletedTurns(messages, turnData);
          useAppStore.getState().setCompletedTurns(sessionId, turns);
        })
        .catch((e) => console.error("Failed to reload turns after rollback:", e));
      // Prefill the input with the rolled-back prompt so the user can re-send
      // or edit it, matching Claude Code's undo behavior.
      if (messageContent) {
        setChatInputPrefill(messageContent);
      }
      // Prefill attachments from the rolled-back message so the user can
      // re-send with the same files. For images the data is already in the
      // store; for PDFs we need to fetch the body on demand.
      if (rolledBackAtts.length > 0) {
        const prefillAtts = await Promise.all(
          rolledBackAtts.map(async (a) => {
            let data = a.data_base64;
            if (!data && a.id) {
              data = await loadAttachmentData(a.id).catch(() => "");
            }
            return {
              filename: a.filename,
              media_type: a.media_type,
              data_base64: data,
            };
          }),
        );
        useAppStore
          .getState()
          .setPendingAttachmentsPrefill(prefillAtts.filter((a) => a.data_base64));
      }
      // Reload attachments to reflect the rolled-back state (FK cascade
      // deletes attachments for removed messages).
      loadAttachmentsForSession(sessionId)
        .then((atts) => useAppStore.getState().setChatAttachments(sessionId, atts))
        .catch((e) => console.error("Failed to reload attachments after rollback:", e));
      // Refresh the changed files view to reflect the rolled-back file state.
      // Diff is workspace-scoped (one worktree per workspace), not per-session.
      clearDiff();
      loadDiffFiles(workspaceId)
        .then((result) => setDiffFiles(result.files, result.merge_base))
        .catch((e) => console.error("Failed to refresh diff after rollback:", e));
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <Modal title="Roll back conversation" onClose={closeModal}>
      <div className={shared.warning}>
        {isClearAll
          ? "Clear the entire conversation and start fresh?"
          : "Roll back to before this message? All messages after this point will be removed."}
        {messagePreview && (
          <div className={shared.quoteLine}>
            &ldquo;{messagePreview}
            {messagePreview.length >= 100 ? "..." : ""}
            &rdquo;
          </div>
        )}
      </div>
      {hasFileChanges && (
        <label className={shared.checkboxRow}>
          <input
            type="checkbox"
            checked={restoreFiles}
            onChange={(e) => setRestoreFiles(e.target.checked)}
          />
          <span>Also restore files to this checkpoint</span>
        </label>
      )}
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleRollback}
          disabled={loading}
        >
          {loading ? "Rolling back..." : "Roll Back"}
        </button>
      </div>
    </Modal>
  );
}
