import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  rollbackToCheckpoint,
  clearConversation,
  loadDiffFiles,
  loadCompletedTurns,
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
  const checkpointId = (modalData.checkpointId as string) ?? null;
  const messagePreview = modalData.messagePreview as string;
  const messageContent = (modalData.messageContent as string) ?? "";
  const hasFileChanges = modalData.hasFileChanges as boolean;
  const isClearAll = !checkpointId;

  const handleRollback = async () => {
    setLoading(true);
    try {
      const messages = isClearAll
        ? await clearConversation(workspaceId, restoreFiles)
        : await rollbackToCheckpoint(workspaceId, checkpointId, restoreFiles);
      rollbackConversation(workspaceId, checkpointId ?? "__clear__", messages);
      // Reload surviving completed turns so tool sections persist.
      loadCompletedTurns(workspaceId)
        .then((turnData) => {
          const turns = reconstructCompletedTurns(messages, turnData);
          useAppStore.getState().setCompletedTurns(workspaceId, turns);
        })
        .catch((e) => console.error("Failed to reload turns after rollback:", e));
      // Prefill the input with the rolled-back prompt so the user can re-send
      // or edit it, matching Claude Code's undo behavior.
      if (messageContent) {
        setChatInputPrefill(messageContent);
      }
      // Refresh the changed files view to reflect the rolled-back file state.
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
    <Modal title="Roll Back Conversation" onClose={closeModal}>
      <div className={shared.warning}>
        {isClearAll
          ? "Clear the entire conversation and start fresh?"
          : "Roll back to before this message? All messages after this point will be removed."}
        {messagePreview && (
          <div style={{ marginTop: 6, opacity: 0.7, fontStyle: "italic" }}>
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
